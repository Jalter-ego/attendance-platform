import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Only non-secret input is persisted. Passwords are read from SSM by attendance-boot.
const input = JSON.parse(readFileSync(process.env.ATTENDANCE_PULUMI_INPUT, 'utf8'));
const { base, tenant_id: tenant, env, sizing, ami } = input;
const roles = ['db', 'backend', 'frontend'];
const prefix = `${base.project_name.slice(0, 12)}-${tenant.slice(0, 16)}-${env}-${createHash('sha256').update(`${base.project_name}/${tenant}/${env}`).digest('hex').slice(0, 8)}`;
const ssmPrefix = `/tenants/${tenant}/${env}`;
const backupPrefix = `tenants/${tenant}/${env}`;
const tags = { Project: base.project_name, Tenant: tenant, Env: env, Plan: input.plan, ManagedBy: 'pulumi' };
const provider = new aws.Provider('tenant-aws', { region: base.region, defaultTags: { tags } });
const options = { provider };
const caller = aws.getCallerIdentityOutput({}, options);
const partition = aws.getPartitionOutput({}, options);
const vpc = aws.ec2.getVpcOutput({ id: base.vpc_id }, options);
const privateSubnet = aws.ec2.getSubnetOutput({ id: base.private_subnet_id }, options);
const publicSubnet = aws.ec2.getSubnetOutput({ id: base.public_subnet_id }, options);
const monitoring = aws.ec2.getSecurityGroupOutput({ id: base.monitoring_security_group_id }, options);
const endpoint = aws.ec2.getVpcEndpointOutput({ id: base.ssm_endpoint_id }, options);
const validBase = pulumi.all([vpc.id, privateSubnet.vpcId, publicSubnet.vpcId, monitoring.vpcId, privateSubnet.availabilityZone,
  endpoint.vpcId, endpoint.serviceName, endpoint.state, endpoint.privateDnsEnabled]).apply(([id, priv, pub, mon, az, epVpc, service, state, dns]) => {
  if ([priv, pub, mon, epVpc].some(value => value !== id) || az !== base.availability_zone || base.private_subnet_id === base.public_subnet_id
    || service !== `com.amazonaws.${base.region}.ssm` || state !== 'available' || !dns)
    throw new Error('Shared base network, availability zone or private SSM endpoint is invalid.');
  return id;
});
const groups = Object.fromEntries(roles.map(role => [role, new aws.ec2.SecurityGroup(`${role}-sg`, {
  vpcId: validBase, description: `Attendance ${tenant}/${env}: ${role}`,
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }], tags: { Name: `${prefix}-${role}`, Role: role },
}, options)]));
const rules = [];
function ingress(name, role, port, source) {
  rules.push(new aws.ec2.SecurityGroupRule(name, { type: 'ingress', protocol: 'tcp', fromPort: port, toPort: port,
    securityGroupId: groups[role].id, ...source }, options));
}
ingress('frontend-http', 'frontend', 80, { cidrBlocks: ['0.0.0.0/0'] });
ingress('backend-api', 'backend', 5000, { sourceSecurityGroupId: groups.frontend.id });
ingress('database', 'db', 5432, { sourceSecurityGroupId: groups.backend.id });
for (const role of roles) for (const port of [9100, 9256, 8889, 19999])
  ingress(`${role}-metrics-${port}`, role, port, { sourceSecurityGroupId: base.monitoring_security_group_id });
ingress('backend-metrics', 'backend', 5000, { sourceSecurityGroupId: base.monitoring_security_group_id });
const volume = new aws.ebs.Volume('db-data', { availabilityZone: base.availability_zone, size: sizing.db_disk_gb,
  type: 'gp3', encrypted: true, tags: { Name: `${prefix}-pgdata`, Role: 'db',
    ...(base.backups_bucket ? { BackupPolicy: `${base.project_name}:${input.backup.schedule}-${input.backup.retention_days}d` } : {}) } }, options);
const agentActions = ['ssm:UpdateInstanceInformation', 'ssm:ListInstanceAssociations', 'ssm:DescribeAssociation',
  'ssm:UpdateInstanceAssociationStatus', 'ssm:GetDocument', 'ssm:DescribeDocument',
  ...['AcknowledgeMessage', 'DeleteMessage', 'FailMessage', 'GetEndpoint', 'GetMessages', 'SendReply'].map(x => `ec2messages:${x}`),
  ...['CreateControlChannel', 'CreateDataChannel', 'OpenControlChannel', 'OpenDataChannel'].map(x => `ssmmessages:${x}`)];
const instances = {};
const powers = {};
let attachment;
for (const role of roles) {
  const iamRole = new aws.iam.Role(`${role}-role`, { name: `${prefix}-${role}`, tags: { Role: role }, assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' } }],
  }) }, options);
  const policy = new aws.iam.RolePolicy(`${role}-policy`, { role: iamRole.id,
    policy: pulumi.all([partition.partition, caller.accountId]).apply(([part, account]) => {
      const statements = [{ Effect: 'Allow', Action: agentActions, Resource: '*' }];
      if (role !== 'frontend') statements.push({ Effect: 'Allow', Action: ['ssm:GetParametersByPath', 'ssm:GetParameters'],
        Resource: [`arn:${part}:ssm:${base.region}:${account}:parameter${ssmPrefix}`, `arn:${part}:ssm:${base.region}:${account}:parameter${ssmPrefix}/*`] });
      if (base.backups_bucket) {
        const bucketArn = `arn:${part}:s3:::${base.backups_bucket}`;
        const path = `${backupPrefix}/${role === 'db' ? 'db' : 'releases'}/*`;
        statements.push({ Effect: 'Allow', Action: role === 'db' ? ['s3:GetObject', 's3:PutObject', 's3:GetObjectTagging', 's3:PutObjectTagging'] : ['s3:GetObject'], Resource: `${bucketArn}/${path}` },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': [path] } } });
      }
      return JSON.stringify({ Version: '2012-10-17', Statement: statements });
    }),
  }, options);
  const profile = new aws.iam.InstanceProfile(`${role}-profile`, { name: `${prefix}-${role}`, role: iamRole.name }, options);
  const image = aws.ec2.getAmiOutput({ owners: ['self'], filters: [{ name: 'image-id', values: [ami[role]] },
    { name: 'tag:Role', values: [role] }, { name: 'state', values: ['available'] },
    { name: 'architecture', values: ['x86_64'] }, { name: 'root-device-type', values: ['ebs'] }] }, options);
  const identity = pulumi.all([vpc.cidrBlock, volume.id, role === 'backend' ? instances.db.privateIp : '',
    role === 'frontend' ? instances.backend.privateIp : '']).apply(([cidr, volumeId, dbHost, backendHost]) => ({
    vm_role: role, tenant_id: tenant, env, plan: input.plan, region: base.region, ssm_prefix: ssmPrefix,
    vpc_cidr: cidr, db_host: dbHost, backend_host: backendHost, db_volume_id: role === 'db' ? volumeId : '',
    institution_name: input.name, timezone: input.timezone, admin_email: input.contact_email, limits: input.limits,
    backup_bucket: base.backups_bucket ?? '', backup_schedule: input.backup.schedule, backup_retention_days: input.backup.retention_days,
  }));
  const userData = identity.apply(data => `#cloud-config\nwrite_files:\n  - path: /etc/attendance/tenant.json\n    owner: root:root\n    permissions: "0640"\n    content: |\n      ${JSON.stringify(data)}\ntimezone: ${JSON.stringify(input.timezone)}\nruncmd:\n  - [/usr/local/sbin/attendance-boot]\n`);
  instances[role] = new aws.ec2.Instance(role, { ami: image.id, instanceType: sizing[role],
    subnetId: role === 'frontend' ? base.public_subnet_id : base.private_subnet_id,
    associatePublicIpAddress: role === 'frontend', vpcSecurityGroupIds: [groups[role].id], iamInstanceProfile: profile.name,
    userData, userDataReplaceOnChange: true, rootBlockDevice: { volumeType: 'gp3', volumeSize: 12, encrypted: true, deleteOnTermination: true },
    metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
    tags: { Name: `${prefix}-${role}`, Role: role },
  }, { ...options, ignoreChanges: role === 'frontend' ? ['associatePublicIpAddress'] : [],
    dependsOn: [policy, ...rules, ...(role === 'backend' ? [attachment] : [])] });
  if (role === 'db') attachment = new aws.ec2.VolumeAttachment('db-data-attachment', {
    deviceName: '/dev/sdf', instanceId: instances.db.id, volumeId: volume.id, stopInstanceBeforeDetaching: true, forceDetach: false,
  }, options);
  // AWS Classic groups aws_ec2_instance_state under ec2transitgateway in its SDK.
  powers[role] = new aws.ec2transitgateway.InstanceState(`${role}-power`, { instanceId: instances[role].id,
    state: input.suspended ? 'stopped' : 'running' }, { ...options, dependsOn: role === 'db' ? [attachment] : [] });
}
export const instance_ids = Object.fromEntries(roles.map(role => [role, instances[role].id]));
export const private_ips = Object.fromEntries(roles.map(role => [role, instances[role].privateIp]));
export const db_volume_id = volume.id;
export const ssm_prefix = ssmPrefix;
export const suspended = !!input.suspended;
// Stop/start can change the public IP without replacing aws.ec2.Instance. Read it
// after the power resource has settled, rather than exporting its stale state IP.
const currentFrontend = aws.ec2.getInstanceOutput({ instanceId: instances.frontend.id }, { ...options, dependsOn: [powers.frontend] });
export const urls = pulumi.all([currentFrontend.publicIp, powers.frontend.state]).apply(([ip, state]) => {
  const root = !input.suspended && state === 'running' && ip ? `http://${ip}` : null;
  return { frontend: root ? `${root}/` : null, api: root ? `${root}/core/api/v1` : null,
    frontend_health: root ? `${root}/healthz` : null, backend_health: root ? `${root}/core/api/v1/health` : null };
});
