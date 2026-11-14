// Pruebas del programa con los mocks de Pulumi: construyen el grafo de recursos sin AWS.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pulumi from '@pulumi/pulumi';

const created = [];

await pulumi.runtime.setMocks({
  newResource({ type, name, inputs }) {
    const index = created.length + 1;
    const state = { ...inputs };
    if (type === 'aws:ec2/instance:Instance') state.privateIp = `10.0.2.${index}`;
    if (type === 'aws:iam/role:Role') state.arn = `arn:aws:iam::123456789012:role/${inputs.name}`;
    created.push({ type, name, inputs });
    return { id: type === 'aws:ec2/instance:Instance' ? `i-${String(index).padStart(17, '0')}` : `${name}-id`, state };
  },
  call({ token, inputs }) {
    switch (token) {
      case 'aws:index/getPartition:getPartition': return { partition: 'aws' };
      case 'aws:index/getCallerIdentity:getCallerIdentity': return { accountId: '123456789012' };
      case 'aws:ec2/getVpc:getVpc': return { id: inputs.id, cidrBlock: '10.0.0.0/16' };
      case 'aws:ec2/getSubnet:getSubnet':
        return { id: inputs.id, vpcId: 'vpc-0123456789abcdef0', availabilityZone: 'us-east-2a' };
      case 'aws:ec2/getSecurityGroup:getSecurityGroup': return { id: inputs.id, vpcId: 'vpc-0123456789abcdef0' };
      case 'aws:ec2/getVpcEndpoint:getVpcEndpoint':
        return { id: inputs.id, vpcId: 'vpc-0123456789abcdef0', serviceName: 'com.amazonaws.us-east-2.ssm', state: 'available', privateDnsEnabled: true };
      case 'aws:ec2/getAmi:getAmi': return { id: inputs.filters[0].values[0] };
      case 'aws:ec2/getInstance:getInstance': return { publicIp: '3.140.10.20' };
      default: throw new Error(`Invoke sin mock: ${token}`);
    }
  },
}, 'attendance-tenant', 'test', false);

const { createTenant, validateInput, resourcePrefix, assertNetwork } = await import('../tenant.js');
const { BOOT_KEYS } = await import('../cloud-init.js');

// promise() es interno de OutputImpl, pero permite esperar también los errores del programa.
const value = (output) => pulumi.output(output).promise();
const byType = (type) => created.filter((resource) => resource.type === type);
// Los registros son asíncronos: espera a que existan los recursos que se revisan.
async function registered(type, count) {
  for (let i = 0; i < 100 && byType(type).length < count; i += 1) await new Promise((r) => setTimeout(r, 10));
  return byType(type);
}
const STATE = 'aws:ec2transitgateway/instanceState:InstanceState';

const input = {
  tenant_id: 'san-marcos', name: 'Colegio San Marcos', env: 'test', region: 'us-east-2', plan: 'basic',
  engine: 'pulumi', contact_email: 'admin@example.edu', timezone: 'America/La_Paz', suspended: false,
  base: {
    project_name: 'attendance-platform', region: 'us-east-2', availability_zone: 'us-east-2a',
    vpc_id: 'vpc-0123456789abcdef0', public_subnet_id: 'subnet-0aaaaaaaaaaaaaaa1', private_subnet_id: 'subnet-0bbbbbbbbbbbbbbb2',
    monitoring_security_group_id: 'sg-0ccccccccccccccc3', ssm_endpoint_id: 'vpce-0ddddddddddddddd4', backups_bucket: 'attendance-backups',
  },
  sizing: { frontend: 't3.micro', backend: 't3.small', db: 't3.small', db_disk_gb: 20 },
  ami: { frontend: 'ami-0123456789abcdef0', backend: 'ami-0123456789abcdef1', db: 'ami-0123456789abcdef2' },
  limits: { max_students: 300 },
  backup: { schedule: 'weekly', retention_days: 28 },
};

beforeEach(() => {
  created.length = 0;
});

test('crea las 3 EC2, el disco de datos, SG, IAM y reglas equivalentes a Terraform', async () => {
  const stack = createTenant(input);
  assert.deepEqual(await value(stack.urls), {
    frontend: 'http://3.140.10.20/', api: 'http://3.140.10.20/core/api/v1',
    frontend_health: 'http://3.140.10.20/healthz', backend_health: 'http://3.140.10.20/core/api/v1/health',
  });
  await value(stack.instance_ids);

  const instances = byType('aws:ec2/instance:Instance');
  assert.deepEqual(instances.map(({ name }) => name).sort(), ['backend', 'db', 'frontend']);
  for (const { inputs } of instances) {
    assert.equal(inputs.metadataOptions.httpTokens, 'required');
    assert.equal(inputs.rootBlockDevice.encrypted, true);
    assert.equal(inputs.userDataReplaceOnChange, true);
  }
  const frontend = instances.find(({ name }) => name === 'frontend').inputs;
  assert.equal(frontend.associatePublicIpAddress, true);
  assert.equal(frontend.subnetId, input.base.public_subnet_id);
  assert.equal(instances.find(({ name }) => name === 'db').inputs.associatePublicIpAddress, false);
  assert.equal(instances.find(({ name }) => name === 'backend').inputs.instanceType, 't3.small');

  const [volume] = byType('aws:ebs/volume:Volume');
  assert.equal(volume.inputs.size, 20);
  assert.equal(volume.inputs.encrypted, true);
  assert.equal(volume.inputs.tags.BackupPolicy, 'attendance-platform:weekly-28d');
  assert.equal(byType('aws:ec2/volumeAttachment:VolumeAttachment')[0].inputs.deviceName, '/dev/sdf');

  assert.equal(byType('aws:ec2/securityGroup:SecurityGroup').length, 3);
  assert.equal(byType('aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule').length, 3 + 12 + 1);
  assert.equal(byType('aws:vpc/securityGroupEgressRule:SecurityGroupEgressRule').length, 3);
  assert.equal(byType('aws:iam/role:Role').length, 3);
  assert.equal(byType('aws:iam/instanceProfile:InstanceProfile').length, 3);
  // 2 SSM (backend, db) + 3 agente + 2 releases + 1 respaldos.
  assert.equal(byType('aws:iam/rolePolicy:RolePolicy').length, 8);
  const frontendPolicies = byType('aws:iam/rolePolicy:RolePolicy').filter(({ name }) => name.startsWith('frontend-'));
  assert.ok(!frontendPolicies.some(({ inputs }) => inputs.name === 'tenant-parameters'), 'el frontend no lee secretos');

  const states = await registered(STATE, 3);
  assert.deepEqual(states.map(({ inputs }) => inputs.state), ['running', 'running', 'running']);

  const provider = byType('pulumi:providers:aws')[0].inputs;
  assert.match(provider.defaultTags, /"ManagedBy":"pulumi"/);
  assert.match(provider.defaultTags, /"Tenant":"san-marcos"/);
});

test('el user data replica la plantilla cloud-init con la identidad de cada VM', async () => {
  const stack = createTenant(input);
  await value(stack.instance_ids);
  const userData = Object.fromEntries(byType('aws:ec2/instance:Instance').map(({ name, inputs }) => [name, inputs.userData]));
  assert.match(userData.db, /^#cloud-config\n/);
  const identity = (text) => JSON.parse(/content: \|\n {6}(.+)\n/.exec(text)[1]);
  const db = identity(userData.db);
  assert.deepEqual(Object.keys(db), BOOT_KEYS);
  assert.equal(db.vm_role, 'db');
  assert.equal(db.db_volume_id, 'db-data-id');
  assert.equal(db.vpc_cidr, '10.0.0.0/16');
  assert.deepEqual(db.limits, { max_students: 300 });
  assert.match(identity(userData.backend).db_host, /^10\.0\.2\.\d+$/);
  assert.match(identity(userData.frontend).backend_host, /^10\.0\.2\.\d+$/);
  assert.equal(identity(userData.frontend).ssm_prefix, '/tenants/san-marcos/test');
  assert.match(userData.frontend, /timezone: America\/La_Paz/);
});

test('las claves de tenant.json coinciden con infra/cloud-init/user-data.yaml.tftpl', async () => {
  const template = await readFile(new URL('../../../cloud-init/user-data.yaml.tftpl', import.meta.url), 'utf8');
  const block = /jsonencode\(\{([\s\S]*?)\}\)/.exec(template)[1];
  const keys = [...block.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((match) => match[1]);
  assert.deepEqual(keys, BOOT_KEYS);
});

test('suspendido: detiene las EC2 y no publica URLs', async () => {
  const stack = createTenant({ ...input, suspended: true });
  await value(stack.instance_ids);
  assert.equal(stack.urls.frontend, null);
  assert.deepEqual((await registered(STATE, 3)).map(({ inputs }) => inputs.state), ['stopped', 'stopped', 'stopped']);
});

test('sin bucket de respaldos no agrega permisos de S3 ni etiqueta DLM', async () => {
  const stack = createTenant({ ...input, base: { ...input.base, backups_bucket: '' } });
  await value(stack.instance_ids);
  assert.deepEqual(byType('aws:iam/rolePolicy:RolePolicy').map(({ inputs }) => inputs.name), ['tenant-parameters', 'tenant-parameters']);
  assert.equal(byType('aws:ebs/volume:Volume')[0].inputs.tags.BackupPolicy, undefined);
});

test('red incoherente: falla como las precondiciones de Terraform', () => {
  const vpc = { id: 'vpc-1', cidrBlock: '10.0.0.0/16' };
  const subnet = (id, vpcId = 'vpc-1') => ({ id, vpcId, availabilityZone: 'us-east-2a' });
  const endpoint = { vpcId: 'vpc-1', serviceName: 'com.amazonaws.us-east-2.ssm', state: 'available', privateDnsEnabled: true };
  const ok = [vpc, subnet('a'), subnet('b'), { vpcId: 'vpc-1' }, endpoint];
  assert.equal(assertNetwork(input.base, ...ok), '10.0.0.0/16');
  assert.throws(() => assertNetwork(input.base, vpc, subnet('a', 'vpc-2'), subnet('b'), ok[3], endpoint), /VPC compartida/);
  assert.throws(() => assertNetwork(input.base, vpc, subnet('a'), subnet('a'), ok[3], endpoint), /VPC compartida/);
  assert.throws(() => assertNetwork(input.base, ...ok.slice(0, 4), { ...endpoint, privateDnsEnabled: false }), /endpoint SSM/);
});

test('valida la entrada igual que variables.tf', () => {
  assert.throws(() => validateInput({ ...input, tenant_id: 'X' }), /tenant_id/);
  assert.throws(() => validateInput({ ...input, sizing: { ...input.sizing, db: 'm5.large' } }), /tamaños/);
  assert.throws(() => validateInput({ ...input, sizing: { ...input.sizing, db_disk_gb: 5 } }), /10 GiB/);
  assert.throws(() => validateInput({ ...input, ami: { ...input.ami, db: 'ami-00000000000000000' } }), /AMIs/);
  assert.throws(() => validateInput({ ...input, backup: { schedule: 'daily', retention_days: 7 } }), /respaldos/);
  assert.equal(resourcePrefix(input).length <= 46, true);
  assert.match(resourcePrefix(input), /^attendance-p-san-marcos-test-[a-f0-9]{8}$/);
});
