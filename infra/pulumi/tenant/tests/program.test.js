import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import * as pulumi from '@pulumi/pulumi';

test('real Pulumi SDK builds three hardened EC2, isolated IAM, persistent EBS and power resources without AWS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pulumi-program-'));
  const previous = process.env.ATTENDANCE_PULUMI_INPUT;
  process.env.ATTENDANCE_PULUMI_INPUT = join(directory, 'input.json');
  const resources = [];
  const calls = [];
  const base = { project_name: 'attendance', region: 'us-east-2', availability_zone: 'us-east-2a', vpc_id: 'vpc-1',
    private_subnet_id: 'subnet-private', public_subnet_id: 'subnet-public', monitoring_security_group_id: 'sg-monitoring',
    ssm_endpoint_id: 'vpce-ssm', backups_bucket: 'tenant-backups' };
  await writeFile(process.env.ATTENDANCE_PULUMI_INPUT, JSON.stringify({ base, tenant_id: 'demo', env: 'test', plan: 'standard',
    name: 'School: "Example"', timezone: 'America/La_Paz', contact_email: 'admin@example.test', limits: { max_students: 1000 },
    sizing: { frontend: 't3.micro', backend: 't3.small', db: 't3.small', db_disk_gb: 50 },
    ami: { db: 'ami-db', backend: 'ami-backend', frontend: 'ami-frontend' },
    backup: { schedule: 'daily', retention_days: 14 }, suspended: false }));
  pulumi.runtime.setMocks({
    newResource(args) {
      resources.push(args);
      return { id: `${args.name}-id`, state: { ...args.inputs,
        ...(args.type === 'aws:ec2/instance:Instance' ? { privateIp: `10.0.1.${resources.length}`, publicIp: '192.0.2.10' } : {}),
        ...(args.type === 'aws:iam/role:Role' ? { name: args.inputs.name } : {}),
      } };
    },
    call(args) {
      calls.push(args);
      if (args.token.includes('getCallerIdentity')) return { accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/test', userId: 'test' };
      if (args.token.includes('getPartition')) return { partition: 'aws', dnsSuffix: 'amazonaws.com', reverseDnsPrefix: 'com.amazonaws' };
      if (args.token.includes('getVpcEndpoint')) return { ...args.inputs, vpcId: 'vpc-1', serviceName: 'com.amazonaws.us-east-2.ssm', state: 'available', privateDnsEnabled: true };
      if (args.token.includes('getVpc:')) return { ...args.inputs, cidrBlock: '10.0.0.0/16' };
      if (args.token.includes('getSubnet')) return { ...args.inputs, vpcId: 'vpc-1', availabilityZone: 'us-east-2a' };
      if (args.token.includes('getSecurityGroup')) return { ...args.inputs, vpcId: 'vpc-1' };
      if (args.token.includes('getAmi')) return { id: args.inputs.filters.find(filter => filter.name === 'image-id').values[0] };
      if (args.token.includes('getInstance')) return { ...args.inputs, publicIp: '192.0.2.20' };
      throw new Error(`Unmocked AWS invoke: ${args.token}`);
    },
  }, 'attendance-tenant', 'attendance-demo-test', false);
  try {
    const program = await import('../index.js');
    const result = await pulumi.output({ urls: program.urls, instance_ids: program.instance_ids,
      private_ips: program.private_ips, db_volume_id: program.db_volume_id }).promise();
    assert.equal(Object.keys(result.instance_ids).length, 3);
    assert.equal(result.db_volume_id, 'db-data-id');
    assert.equal(result.urls.frontend, 'http://192.0.2.20/');
    const instances = resources.filter(resource => resource.type === 'aws:ec2/instance:Instance');
    assert.equal(instances.length, 3);
    for (const instance of instances) {
      assert.equal(instance.inputs.metadataOptions.httpTokens, 'required');
      assert.equal(instance.inputs.rootBlockDevice.encrypted, true);
      assert.equal(instance.inputs.userDataReplaceOnChange, true);
      assert.equal(instance.inputs.associatePublicIpAddress, instance.name === 'frontend');
      const identityLine = instance.inputs.userData.split('\n').find(line => line.trim().startsWith('{'));
      const identity = JSON.parse(identityLine.trim());
      assert.equal(identity.vm_role, instance.name);
      assert.equal(identity.institution_name, 'School: "Example"');
      assert.equal(identity.ssm_prefix, '/tenants/demo/test');
      assert.ok(!instance.inputs.userData.includes('password'));
    }
    assert.equal(resources.filter(resource => resource.type === 'aws:ec2transitgateway/instanceState:InstanceState').length, 3);
    const volume = resources.find(resource => resource.type === 'aws:ebs/volume:Volume');
    assert.equal(volume.inputs.encrypted, true); assert.equal(volume.inputs.size, 50);
    const rules = resources.filter(resource => resource.type === 'aws:ec2/securityGroupRule:SecurityGroupRule');
    assert.equal(rules.filter(rule => rule.inputs.cidrBlocks?.includes('0.0.0.0/0')).length, 1);
    assert.equal(rules.find(rule => rule.name === 'database').inputs.sourceSecurityGroupId, 'backend-sg-id');
    const policies = resources.filter(resource => resource.type === 'aws:iam/rolePolicy:RolePolicy');
    assert.equal(policies.length, 3);
    assert.ok(!policies.find(policy => policy.name === 'frontend-policy').inputs.policy.includes('ssm:GetParameters'));
    const dbPolicy = JSON.parse(policies.find(policy => policy.name === 'db-policy').inputs.policy);
    const ssm = dbPolicy.Statement.find(statement => statement.Action.includes('ssm:GetParameters'));
    assert.deepEqual(ssm.Resource, ['arn:aws:ssm:us-east-2:123456789012:parameter/tenants/demo/test',
      'arn:aws:ssm:us-east-2:123456789012:parameter/tenants/demo/test/*']);
    assert.equal(calls.filter(call => call.token.includes('getAmi')).length, 3);
  } finally {
    if (previous === undefined) delete process.env.ATTENDANCE_PULUMI_INPUT;
    else process.env.ATTENDANCE_PULUMI_INPUT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
