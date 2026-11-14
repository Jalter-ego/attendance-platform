// Stack de un tenant con Pulumi (P2, D3). Recursos, nombres, reglas y etiquetas equivalentes
// a infra/terraform/tenant (P1), para que los motores sean comparables (D6).
import { createHash } from 'node:crypto';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { renderUserData } from './cloud-init.js';

export const ROLES = ['frontend', 'backend', 'db'];
const SIZES = ['t3.micro', 't3.small', 't3.medium', 't3.large'];
const BACKUP_POLICIES = ['weekly-28', 'daily-14', 'daily-30'];
const EXPORTER_PORTS = [9100, 9256, 8889, 19999];

// Solo comunicaciones del agente SSM: no envía comandos ni lee secretos.
// No se usa AmazonSSMManagedInstanceCore (ssm:GetParameters sobre "*").
const SSM_AGENT_ACTIONS = [
  'ssm:UpdateInstanceInformation', 'ssm:ListInstanceAssociations', 'ssm:DescribeAssociation',
  'ssm:UpdateInstanceAssociationStatus', 'ssm:GetDocument', 'ssm:DescribeDocument',
  'ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage',
  'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply',
  'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
];

/** Mismas validaciones que variables.tf del módulo Terraform. */
export function validateInput(input) {
  const fail = (message) => { throw new Error(`Configuración del tenant inválida: ${message}`); };
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(input?.tenant_id ?? ''))
    fail('tenant_id debe tener 3-40 caracteres: minúsculas, números y guiones.');
  if (!['test', 'prod'].includes(input.env)) fail('el entorno debe ser test o prod.');
  if (!String(input.name ?? '').trim()) fail('indica el nombre de la institución.');
  if (!/^[A-Za-z0-9_+/-]+$/.test(input.timezone ?? '')) fail('timezone debe ser una zona IANA.');
  for (const key of ['project_name', 'region', 'availability_zone', 'vpc_id', 'public_subnet_id',
    'private_subnet_id', 'monitoring_security_group_id', 'ssm_endpoint_id'])
    if (!input.base?.[key]) fail(`falta base.${key} (outputs de infra/terraform/base).`);
  const { sizing = {} } = input;
  if (!ROLES.every((role) => SIZES.includes(sizing[role])))
    fail(`los tamaños admitidos son ${SIZES.join(', ')}.`);
  if (!Number.isInteger(sizing.db_disk_gb) || sizing.db_disk_gb < 10)
    fail('el disco de PostgreSQL debe tener al menos 10 GiB, en un número entero.');
  if (!ROLES.every((role) => /^ami-[a-f0-9]{17}$/.test(input.ami?.[role] ?? '') && input.ami[role] !== 'ami-00000000000000000'))
    fail('indica IDs reales de las tres AMIs de Packer.');
  const backup = input.backup ?? { schedule: 'weekly', retention_days: 28 };
  if (!BACKUP_POLICIES.includes(`${backup.schedule}-${backup.retention_days}`))
    fail('respaldos admitidos: weekly/28, daily/14 o daily/30.');
  return { ...input, backup, limits: input.limits ?? {}, suspended: Boolean(input.suspended) };
}

/** Mismo prefijo que locals.tf: los nombres IAM tienen un límite de 64 caracteres. */
export function resourcePrefix({ base, tenant_id: tenant, env }) {
  const hash = createHash('sha256').update(`${base.project_name}/${tenant}/${env}`).digest('hex').slice(0, 8);
  return `${base.project_name.slice(0, 12)}-${tenant.slice(0, 16)}-${env}-${hash}`;
}

/** Precondiciones de Terraform: red compartida coherente y endpoint SSM disponible. Devuelve el CIDR. */
export function assertNetwork(base, vpc, publicSubnet, privateSubnet, monitoring, endpoint) {
  if (publicSubnet.vpcId !== vpc.id || privateSubnet.vpcId !== vpc.id || monitoring.vpcId !== vpc.id
    || publicSubnet.id === privateSubnet.id || privateSubnet.availabilityZone !== base.availability_zone)
    throw new Error('Las subredes y el SG deben pertenecer a la VPC compartida; la BD y su EBS deben usar la misma AZ.');
  if (endpoint.vpcId !== vpc.id || endpoint.serviceName !== `com.amazonaws.${base.region}.ssm`
    || endpoint.state !== 'available' || !endpoint.privateDnsEnabled)
    throw new Error('Actualiza la base: se requiere el endpoint SSM disponible, en la misma VPC y con DNS privado.');
  return vpc.cidrBlock;
}

const policy = (statements) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

export function createTenant(rawInput) {
  const input = validateInput(rawInput);
  const { base, tenant_id: tenantId, env } = input;
  const prefix = resourcePrefix(input);
  const ssmPrefix = `/tenants/${tenantId}/${env}`;
  const backupPrefix = `tenants/${tenantId}/${env}`;
  const releasePrefix = `${backupPrefix}/releases`;
  const backups = Boolean(base.backups_bucket);
  const backupPolicy = `${input.backup.schedule}-${input.backup.retention_days}d`;

  // Etiquetas obligatorias del proyecto en todos los recursos (default_tags en Terraform).
  const provider = new aws.Provider('tenant', {
    region: base.region,
    defaultTags: { tags: {
      Project: base.project_name, Tenant: tenantId, Env: env, Plan: input.plan, ManagedBy: 'pulumi',
    } },
  });
  const opts = { provider };

  const partition = aws.getPartitionOutput({}, opts).partition;
  const account = aws.getCallerIdentityOutput({}, opts).accountId;
  const ssmArn = pulumi.interpolate`arn:${partition}:ssm:${base.region}:${account}:parameter${ssmPrefix}`;
  const bucketArn = pulumi.interpolate`arn:${partition}:s3:::${base.backups_bucket}`;

  const vpcCidr = pulumi.all([
    aws.ec2.getVpcOutput({ id: base.vpc_id }, opts),
    aws.ec2.getSubnetOutput({ id: base.public_subnet_id }, opts),
    aws.ec2.getSubnetOutput({ id: base.private_subnet_id }, opts),
    aws.ec2.getSecurityGroupOutput({ id: base.monitoring_security_group_id }, opts),
    aws.ec2.getVpcEndpointOutput({ id: base.ssm_endpoint_id }, opts),
  ]).apply(([vpc, ...rest]) => assertNetwork(base, vpc, ...rest));

  // AMIs concretas de Packer: propias, disponibles, x86_64 y con la etiqueta Role correcta.
  const amis = Object.fromEntries(ROLES.map((role) => [role, aws.ec2.getAmiOutput({
    owners: ['self'],
    filters: [
      { name: 'image-id', values: [input.ami[role]] },
      { name: 'tag:Role', values: [role] },
      { name: 'state', values: ['available'] },
      { name: 'architecture', values: ['x86_64'] },
      { name: 'root-device-type', values: ['ebs'] },
    ],
  }, opts).id]));

  // Un SG por rol, con las mismas reglas que security.tf.
  const sg = Object.fromEntries(ROLES.map((role) => [role, new aws.ec2.SecurityGroup(`sg-${role}`, {
    namePrefix: `${prefix}-${role}-`,
    description: `Attendance ${tenantId}/${env}: ${role}`,
    vpcId: base.vpc_id,
    tags: { Name: `${prefix}-${role}`, Role: role },
  }, opts)]));
  const ingress = (name, args) => new aws.vpc.SecurityGroupIngressRule(name, { ipProtocol: 'tcp', ...args }, opts);
  ingress('frontend-http', { securityGroupId: sg.frontend.id, description: 'Navegador hacia nginx', cidrIpv4: '0.0.0.0/0', fromPort: 80, toPort: 80 });
  ingress('backend-api', { securityGroupId: sg.backend.id, description: 'Solo el proxy de este tenant', referencedSecurityGroupId: sg.frontend.id, fromPort: 5000, toPort: 5000 });
  ingress('database', { securityGroupId: sg.db.id, description: 'Solo el backend de este tenant', referencedSecurityGroupId: sg.backend.id, fromPort: 5432, toPort: 5432 });
  for (const role of ROLES)
    for (const port of EXPORTER_PORTS)
      ingress(`exporter-${role}-${port}`, { securityGroupId: sg[role].id, description: 'Exporters solo desde monitoreo compartido', referencedSecurityGroupId: base.monitoring_security_group_id, fromPort: port, toPort: port });
  ingress('backend-metrics', { securityGroupId: sg.backend.id, description: 'Monitoreo de la API; P4/P5 definen la ruta de metricas', referencedSecurityGroupId: base.monitoring_security_group_id, fromPort: 5000, toPort: 5000 });
  const egress = ROLES.map((role) => new aws.vpc.SecurityGroupEgressRule(`outbound-${role}`, {
    securityGroupId: sg[role].id, description: 'Salida sujeta a las rutas y a los SG de destino', cidrIpv4: '0.0.0.0/0', ipProtocol: '-1',
  }, opts));

  // IAM por servidor (iam.tf): backend y db leen solo el prefijo SSM de este tenant.
  const roles = {};
  const profiles = {};
  const policies = { frontend: [], backend: [], db: [] };
  for (const role of ROLES) {
    roles[role] = new aws.iam.Role(`role-${role}`, {
      name: `${prefix}-${role}`,
      assumeRolePolicy: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' } }]),
      tags: { Role: role },
    }, opts);
    profiles[role] = new aws.iam.InstanceProfile(`profile-${role}`, { name: roles[role].name, role: roles[role].name, tags: { Role: role } }, opts);
  }
  const rolePolicy = (role, name, document) => policies[role].push(
    new aws.iam.RolePolicy(`${role}-${name}`, { name, role: roles[role].id, policy: document }, opts),
  );
  for (const role of ['backend', 'db'])
    rolePolicy(role, 'tenant-parameters', ssmArn.apply((arn) => policy([
      { Effect: 'Allow', Action: ['ssm:GetParametersByPath', 'ssm:GetParameters'], Resource: [arn, `${arn}/*`] },
    ])));
  if (backups) {
    for (const role of ROLES)
      rolePolicy(role, 'ssm-agent-run-command', policy([{ Effect: 'Allow', Action: SSM_AGENT_ACTIONS, Resource: '*' }]));
    for (const role of ['frontend', 'backend'])
      rolePolicy(role, 'tenant-releases', bucketArn.apply((arn) => policy([
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: `${arn}/${releasePrefix}/*` },
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: arn, Condition: { StringLike: { 's3:prefix': [`${releasePrefix}/*`] } } },
      ])));
    rolePolicy('db', 'tenant-backups', bucketArn.apply((arn) => policy([
      { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:PutObjectTagging', 's3:GetObjectTagging'], Resource: `${arn}/${backupPrefix}/db/*` },
      { Effect: 'Allow', Action: 's3:ListBucket', Resource: arn, Condition: { StringLike: { 's3:prefix': [`${backupPrefix}/db/*`] } } },
    ])));
  }

  // Disco de PostgreSQL. `protect` impide que un update lo elimine o reemplace: solo la
  // eliminación explícita del tenant lo libera (el adaptador hace `state unprotect`).
  const dbVolume = new aws.ebs.Volume('db-data', {
    availabilityZone: base.availability_zone,
    size: input.sizing.db_disk_gb,
    type: 'gp3',
    encrypted: true,
    tags: {
      Name: `${prefix}-pgdata`, Role: 'db',
      ...(backups ? { BackupPolicy: `${base.project_name}:${backupPolicy}` } : {}),
    },
  }, { ...opts, protect: true });

  const boot = (role, extra) => pulumi.all([vpcCidr, extra]).apply(([cidr, values]) => renderUserData({
    vm_role: role, tenant_id: tenantId, env, plan: input.plan, region: base.region, ssm_prefix: ssmPrefix,
    vpc_cidr: cidr, db_host: '', backend_host: '', db_volume_id: '', institution_name: input.name,
    timezone: input.timezone, admin_email: input.contact_email, limits: input.limits,
    backup_bucket: base.backups_bucket ?? '', backup_schedule: input.backup.schedule,
    backup_retention_days: input.backup.retention_days, ...values,
  }));
  const instance = (role, { subnetId, publicIp, userData, dependsOn }) => new aws.ec2.Instance(role, {
    ami: amis[role],
    instanceType: input.sizing[role],
    subnetId,
    associatePublicIpAddress: publicIp,
    vpcSecurityGroupIds: [sg[role].id],
    iamInstanceProfile: profiles[role].name,
    userDataReplaceOnChange: true,
    userData,
    rootBlockDevice: { volumeType: 'gp3', volumeSize: 12, encrypted: true, deleteOnTermination: true },
    metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
    tags: { Name: `${prefix}-${role}`, Role: role },
  }, { ...opts, dependsOn: [...policies[role], ...egress, ...dependsOn] });

  // Orden: EBS → db → adjuntar disco → backend (IP de db) → frontend (IP del backend).
  const db = instance('db', {
    subnetId: base.private_subnet_id, publicIp: false, dependsOn: [],
    userData: boot('db', { db_volume_id: dbVolume.id }),
  });
  const attachment = new aws.ec2.VolumeAttachment('db-data', {
    deviceName: '/dev/sdf', volumeId: dbVolume.id, instanceId: db.id,
    stopInstanceBeforeDetaching: true, forceDetach: false,
  }, opts);
  const backend = instance('backend', {
    subnetId: base.private_subnet_id, publicIp: false, dependsOn: [attachment],
    userData: boot('backend', { db_host: db.privateIp }),
  });
  const frontend = instance('frontend', {
    subnetId: base.public_subnet_id, publicIp: true, dependsOn: [],
    userData: boot('frontend', { backend_host: backend.privateIp }),
  });
  const instances = { frontend, backend, db };

  // Suspender/reanudar es declarativo, como aws_ec2_instance_state en Terraform.
  const states = ROLES.map((role) => new aws.ec2transitgateway.InstanceState(`state-${role}`, {
    instanceId: instances[role].id, state: input.suspended ? 'stopped' : 'running', force: false,
  }, { ...opts, dependsOn: [attachment] }));

  // La IP pública cambia al reanudar: se lee de nuevo después del cambio de estado.
  const publicIp = aws.ec2.getInstanceOutput({ instanceId: frontend.id }, { ...opts, dependsOn: states }).publicIp;
  const url = (path) => (input.suspended ? null : pulumi.interpolate`http://${publicIp}${path}`);

  return {
    deployment_name: prefix,
    urls: {
      frontend: url('/'),
      api: url('/core/api/v1'),
      frontend_health: url('/healthz'),
      backend_health: url('/core/api/v1/health'),
    },
    suspended: input.suspended,
    instance_ids: { frontend: frontend.id, backend: backend.id, db: db.id },
    private_ips: { frontend: frontend.privateIp, backend: backend.privateIp, db: db.privateIp },
    db_volume_id: dbVolume.id,
    ssm_prefix: ssmPrefix,
    instance_role_arns: Object.fromEntries(ROLES.map((role) => [role, roles[role].arn])),
    ami_ids: amis,
    backup: { bucket: base.backups_bucket ?? '', prefix: backupPrefix, policy: backups ? backupPolicy : null },
    releases: { bucket: base.backups_bucket ?? '', prefix: releasePrefix, enabled: backups },
  };
}
