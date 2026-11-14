// Pruebas del adaptador CloudFormation (P2) sin AWS: clientes CloudFormation y EC2 simulados.
// Ejecutar con `pnpm test:cloudformation`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import {
  bootIdentity,
  createCloudFormationAdapter,
  stackName,
  stackParameters,
  stackTags,
  summarizeChanges,
} from '../src/engines/cloudformation.js';
import { BACKUP_BY_PLAN } from '../src/engines/tenant-input.js';
import { OperationError } from '../src/worker/errors.js';

const input = {
  tenant_id: 'demo-cfn',
  name: 'Colegio "Demo"',
  env: 'test',
  region: 'us-east-2',
  plan: 'basic',
  engine: 'cloudformation',
  contact_email: 'admin@example.com',
  timezone: 'America/La_Paz',
  sizing: { frontend: 't3.micro', backend: 't3.micro', db: 't3.micro', db_disk_gb: 10 },
  limits: { max_students: 100, max_teachers: 10, max_courses: 20 },
  backup: BACKUP_BY_PLAN.basic,
  ami: { frontend: 'ami-0aaaaaaaaaaaaaaa1', backend: 'ami-0aaaaaaaaaaaaaaa2', db: 'ami-0aaaaaaaaaaaaaaa3' },
  suspended: false,
  image: { version: '0.2.2', git_commit: '25155ea' },
  base: {
    project_name: 'attendance-platform',
    region: 'us-east-2',
    availability_zone: 'us-east-2a',
    vpc_id: 'vpc-1',
    public_subnet_id: 'subnet-pub',
    private_subnet_id: 'subnet-priv',
    monitoring_security_group_id: 'sg-mon',
    ssm_endpoint_id: 'vpce-1',
    backups_bucket: 'backups-bucket',
  },
};

const notFound = (name) =>
  Object.assign(new Error(`Stack with id ${name} does not exist`), { name: 'ValidationError' });

/**
 * AWS simulado. `scenario`:
 *  - changes: cambios del change set; FAILED sin cambios si es [] en UPDATE.
 *  - executeResult: estado final al ejecutar (CREATE_COMPLETE, ROLLBACK_COMPLETE...).
 *  - failReason: motivo del evento *_FAILED.
 *  - existing: estado inicial del stack (null = no existe).
 *  - roleTag: etiqueta Role de la AMI de db (para probar la validación).
 */
function fakeAws(scenario = {}) {
  const calls = [];
  const instances = {
    'i-f': { state: 'running', ip: '3.3.3.3' },
    'i-b': { state: 'running' },
    'i-d': { state: 'running' },
  };
  let stack = scenario.existing
    ? { StackId: 'arn:stack/demo/1', StackStatus: scenario.existing, Outputs: [] }
    : null;
  let events = [];
  const outputs = [
    ['FrontendInstanceId', 'i-f'],
    ['BackendInstanceId', 'i-b'],
    ['DbInstanceId', 'i-d'],
    ['FrontendPrivateIp', '10.0.1.10'],
    ['BackendPrivateIp', '10.0.2.10'],
    ['DbPrivateIp', '10.0.2.20'],
    ['FrontendPublicIp', '3.3.3.3'],
    ['DbVolumeId', 'vol-1'],
    ['SsmPrefix', '/tenants/demo-cfn/test'],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
  const event = (logical, status, reason) => ({
    EventId: `${logical}-${status}-${events.length}`,
    Timestamp: new Date(Date.now() + 1000),
    LogicalResourceId: logical,
    ResourceType: 'AWS::EC2::Instance',
    ResourceStatus: status,
    ResourceStatusReason: reason,
  });
  const cfn = {
    async send(command) {
      const name = command.constructor.name;
      const params = command.input;
      calls.push({ name, params });
      switch (name) {
        case 'DescribeStacksCommand':
          if (!stack) throw notFound(params.StackName);
          if (stack.StackStatus === 'DELETE_COMPLETE' && params.StackName !== stack.StackId)
            throw notFound(params.StackName);
          return { Stacks: [stack] };
        case 'CreateChangeSetCommand':
          if (params.ChangeSetType === 'CREATE')
            stack = { StackId: 'arn:stack/demo/2', StackStatus: 'REVIEW_IN_PROGRESS', Outputs: [] };
          return { Id: 'cs-1' };
        case 'DescribeChangeSetCommand': {
          const changes = scenario.changes ?? [];
          if (!changes.length && stack.StackStatus !== 'REVIEW_IN_PROGRESS')
            return { Status: 'FAILED', StatusReason: "The submitted information didn't contain changes." };
          return { Status: 'CREATE_COMPLETE', Changes: changes };
        }
        case 'ExecuteChangeSetCommand': {
          const final = scenario.executeResult ?? 'CREATE_COMPLETE';
          events = [
            event('DbInstance', 'CREATE_IN_PROGRESS'),
            ...(final.includes('ROLLBACK')
              ? [event('DbInstance', 'CREATE_FAILED', scenario.failReason), event('FrontendInstance', 'CREATE_FAILED', 'Resource creation cancelled')]
              : [event('DbInstance', 'CREATE_COMPLETE')]),
          ].reverse();
          stack = { ...stack, StackStatus: final, Outputs: final.includes('ROLLBACK') ? [] : outputs };
          return {};
        }
        case 'DescribeStackEventsCommand':
          return { StackEvents: events };
        case 'DeleteChangeSetCommand':
          return {};
        case 'DeleteStackCommand':
          stack = { ...stack, StackStatus: 'DELETE_COMPLETE' };
          events = [event('DbVolume', 'DELETE_COMPLETE')];
          return {};
        case 'DescribeStackResourcesCommand':
          return {
            StackResources: [
              { LogicalResourceId: 'DbInstance', ResourceType: 'AWS::EC2::Instance' },
              { LogicalResourceId: 'DbVolume', ResourceType: 'AWS::EC2::Volume' },
            ],
          };
        default:
          throw new Error(`cfn simulado: ${name}`);
      }
    },
  };
  const ec2 = {
    async send(command) {
      const name = command.constructor.name;
      const params = command.input;
      calls.push({ name, params });
      switch (name) {
        case 'DescribeImagesCommand':
          return {
            Images: Object.entries(input.ami).map(([role, id]) => ({
              ImageId: id,
              State: 'available',
              Tags: [{ Key: 'Role', Value: role === 'db' ? (scenario.roleTag ?? 'db') : role }],
            })),
          };
        case 'DescribeVpcsCommand':
          return { Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.20.0.0/16' }] };
        case 'DescribeInstancesCommand':
          return {
            Reservations: [
              {
                Instances: params.InstanceIds.map((id) => ({
                  InstanceId: id,
                  State: { Name: instances[id].state },
                  PublicIpAddress: instances[id].state === 'running' ? instances[id].ip : undefined,
                })),
              },
            ],
          };
        case 'StopInstancesCommand':
          for (const id of params.InstanceIds) instances[id].state = 'stopped';
          return {};
        case 'StartInstancesCommand':
          for (const id of params.InstanceIds) instances[id].state = 'running';
          instances['i-f'].ip = '4.4.4.4';
          return {};
        default:
          throw new Error(`ec2 simulado: ${name}`);
      }
    },
  };
  return { cfn, ec2, calls, setStack: (value) => (stack = value) };
}

function adapter(aws) {
  return createCloudFormationAdapter({
    ...readConfig({ DATABASE_URL: 'postgresql://unused' }),
    CFN_POLL_MS: 10,
    cfnClient: aws.cfn,
    ec2Client: aws.ec2,
  });
}

function context(events = []) {
  return {
    input,
    events,
    logRef: 'operations/test',
    report: async (message, options = {}) => {
      events.push({ message, ...options });
    },
  };
}

const add = (logical, type = 'AWS::EC2::Instance') => ({
  ResourceChange: { Action: 'Add', LogicalResourceId: logical, ResourceType: type },
});

test('parámetros, identidad de cloud-init y etiquetas del stack', () => {
  assert.equal(stackName(input), 'attendance-platform-demo-cfn-test');
  const identity = JSON.parse(`{${bootIdentity(input, '10.20.0.0/16')}}`);
  assert.equal(identity.vpc_cidr, '10.20.0.0/16');
  assert.equal(identity.institution_name, 'Colegio "Demo"');
  assert.equal(identity.ssm_prefix, '/tenants/demo-cfn/test');
  assert.deepEqual(identity.limits, input.limits);
  const params = Object.fromEntries(
    stackParameters(input, '10.20.0.0/16').map((item) => [item.ParameterKey, item.ParameterValue]),
  );
  assert.equal(params.DbDiskGb, '10');
  assert.equal(params.BackupPolicyTag, 'attendance-platform:weekly-28d');
  assert.equal(params.DbAmi, input.ami.db);
  assert.ok(Object.values(params).every((value) => typeof value === 'string'));
  assert.deepEqual(stackTags(input).find((tag) => tag.Key === 'ManagedBy'), {
    Key: 'ManagedBy',
    Value: 'cloudformation',
  });
});

test('summarizeChanges detecta reemplazo o eliminación del disco de datos', () => {
  const summary = summarizeChanges([
    add('DbInstance'),
    { ResourceChange: { Action: 'Modify', Replacement: 'True', LogicalResourceId: 'DbVolume', ResourceType: 'AWS::EC2::Volume' } },
    { ResourceChange: { Action: 'Remove', LogicalResourceId: 'OldSg', ResourceType: 'AWS::EC2::SecurityGroup' } },
  ]);
  assert.deepEqual(summary.totals, { create: 1, update: 1, delete: 1, replace: 1 });
  assert.deepEqual(summary.data_volumes_deleted, ['DbVolume']);
  assert.match(summary.lines[1], /^Reemplazar DbVolume/);
});

test('crear: change set CREATE, eventos, outputs con IP de EC2 y versiones', async () => {
  const aws = fakeAws({ changes: [add('DbInstance'), add('DbVolume', 'AWS::EC2::Volume')] });
  const ctx = context();
  const result = await adapter(aws).apply(ctx);
  const create = aws.calls.find((call) => call.name === 'CreateChangeSetCommand').params;
  assert.equal(create.ChangeSetType, 'CREATE');
  assert.equal(create.StackName, 'attendance-platform-demo-cfn-test');
  assert.deepEqual(create.Capabilities, ['CAPABILITY_IAM']);
  assert.match(create.TemplateBody, /AWSTemplateFormatVersion/);
  assert.ok(aws.calls.some((call) => call.name === 'ExecuteChangeSetCommand'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs.urls.frontend_health, 'http://3.3.3.3/healthz');
  assert.equal(result.outputs.instance_ids.db, 'i-d');
  assert.equal(result.outputs.suspended, false);
  assert.deepEqual(
    result.resources.map((item) => `${item.type}:${item.role}`),
    ['aws_instance:frontend', 'aws_instance:backend', 'aws_instance:db', 'aws_ebs_volume:db'],
  );
  assert.equal(result.tool_versions.engine, 'cloudformation');
  assert.match(result.tool_versions.template_sha256, /^[0-9a-f]{12}$/);
  assert.equal(result.tool_versions.aws_sdk, '3.1168.0');
  assert.ok(ctx.events.some((event) => /DbInstance \(AWS::EC2::Instance\): CREATE_COMPLETE/.test(event.message)));
  assert.ok(ctx.events.some((event) => /Plan: crear 2, modificar 0, eliminar 0/.test(event.message)));
});

test('sin cambios no ejecuta el change set (reintento idempotente)', async () => {
  const aws = fakeAws({ existing: 'CREATE_COMPLETE', changes: [] });
  aws.setStack({ StackId: 'arn:stack/demo/1', StackStatus: 'CREATE_COMPLETE', Outputs: [
    { OutputKey: 'FrontendInstanceId', OutputValue: 'i-f' },
    { OutputKey: 'BackendInstanceId', OutputValue: 'i-b' },
    { OutputKey: 'DbInstanceId', OutputValue: 'i-d' },
  ] });
  const ctx = context();
  await adapter(aws).apply(ctx);
  assert.equal(aws.calls.find((call) => call.name === 'CreateChangeSetCommand').params.ChangeSetType, 'UPDATE');
  assert.ok(!aws.calls.some((call) => call.name === 'ExecuteChangeSetCommand'));
  assert.ok(aws.calls.some((call) => call.name === 'DeleteChangeSetCommand'));
  assert.ok(ctx.events.some((event) => /Sin cambios/.test(event.message)));
});

test('un change set que reemplaza el disco de datos se descarta sin aplicar', async () => {
  const aws = fakeAws({
    existing: 'UPDATE_COMPLETE',
    changes: [{ ResourceChange: { Action: 'Modify', Replacement: 'True', LogicalResourceId: 'DbVolume', ResourceType: 'AWS::EC2::Volume' } }],
  });
  await assert.rejects(adapter(aws).apply(context()), { code: 'DATA_LOSS_BLOCKED' });
  assert.ok(aws.calls.some((call) => call.name === 'DeleteChangeSetCommand'));
  assert.ok(!aws.calls.some((call) => call.name === 'ExecuteChangeSetCommand'));
});

test('un fallo de creación muestra el motivo del recurso de forma comprensible', async () => {
  const aws = fakeAws({
    changes: [add('DbInstance')],
    executeResult: 'ROLLBACK_COMPLETE',
    failReason: 'You have requested more vCPU capacity than your current vCPU limit (VcpuLimitExceeded)',
  });
  await assert.rejects(
    adapter(aws).apply(context()),
    (error) => error instanceof OperationError && /cuota de vCPU/.test(error.message),
  );
});

test('reintentar tras ROLLBACK_COMPLETE elimina el stack fallido y crea otro', async () => {
  const aws = fakeAws({ existing: 'ROLLBACK_COMPLETE', changes: [add('DbInstance')] });
  await adapter(aws).apply(context());
  const names = aws.calls.map((call) => call.name);
  assert.ok(names.indexOf('DeleteStackCommand') < names.indexOf('CreateChangeSetCommand'));
  assert.equal(aws.calls.find((call) => call.name === 'CreateChangeSetCommand').params.ChangeSetType, 'CREATE');
});

test('suspender y reanudar usan la API de EC2 y recalculan la URL (D5)', async () => {
  const aws = fakeAws({ changes: [add('DbInstance')] });
  const cfn = adapter(aws);
  await cfn.apply(context());
  const suspended = await cfn.suspend(context());
  assert.ok(aws.calls.some((call) => call.name === 'StopInstancesCommand'));
  assert.equal(suspended.outputs.suspended, true);
  assert.equal(suspended.outputs.urls.frontend, null);
  const resumed = await cfn.resume(context());
  assert.ok(aws.calls.some((call) => call.name === 'StartInstancesCommand'));
  assert.equal(resumed.outputs.urls.frontend, 'http://4.4.4.4/');
  assert.equal(resumed.outputs.suspended, false);
});

test('eliminar borra el stack y la vista previa avisa del disco de datos', async () => {
  const aws = fakeAws({ changes: [add('DbInstance')] });
  const cfn = adapter(aws);
  await cfn.apply(context());
  const preview = await cfn.preview(context(), { destroy: true });
  assert.deepEqual(preview.data_volumes_deleted, ['DbVolume']);
  const result = await cfn.destroy(context());
  assert.ok(aws.calls.some((call) => call.name === 'DeleteStackCommand'));
  assert.deepEqual(result.resources, []);
});

test('rechaza AMIs sin la etiqueta Role correcta', async () => {
  const aws = fakeAws({ roleTag: 'backend' });
  await assert.rejects(adapter(aws).apply(context()), { code: 'IAC_INPUT' });
  assert.ok(!aws.calls.some((call) => call.name === 'CreateChangeSetCommand'));
});
