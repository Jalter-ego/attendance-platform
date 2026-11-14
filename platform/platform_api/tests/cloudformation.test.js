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
import { OperationError, OperationCancelled } from '../src/worker/errors.js';
import { fakeCloudFormation } from './fixtures/fake-cloudformation.js';
import { publicDeployment } from '../src/modules/deployments/deployment-config.js';

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

const fakeAws = (scenario) => fakeCloudFormation(input, scenario);

function adapter(aws, settings = {}) {
  return createCloudFormationAdapter({
    ...readConfig({ DATABASE_URL: 'postgresql://unused' }),
    CFN_POLL_MS: 10,
    cfnClient: aws.cfn,
    ec2Client: aws.ec2,
    ...settings,
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
  assert.equal(result.outputs.urls.frontend_health, 'http://198.51.100.40/healthz');
  assert.equal(result.outputs.instance_ids.db, 'i-33333333333333333');
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
  aws.setStack({ StackId: aws.stackArn, StackStatus: 'CREATE_COMPLETE', Outputs: aws.outputs });
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
  assert.equal(resumed.outputs.urls.frontend, 'http://198.51.100.41/');
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

test('espera el evento raíz de su request y descarta estados COMPLETE anteriores', async () => {
  const aws = fakeAws({ existing: 'UPDATE_COMPLETE', executeResult: 'UPDATE_COMPLETE', staleStablePolls: 2,
    changes: [{ ResourceChange: { Action: 'Modify', Replacement: 'False', LogicalResourceId: 'BackendInstance', ResourceType: 'AWS::EC2::Instance' } }],
  });
  await adapter(aws).apply(context());
  assert.equal(aws.calls.filter((call) => call.name === 'DescribeStackEventsCommand').length, 3);
  const execute = aws.calls.find((call) => call.name === 'ExecuteChangeSetCommand').params;
  assert.match(execute.ClientRequestToken, /^[a-f0-9-]{36}$/);
  assert.equal(execute.DisableRollback, false);
});

test('acota el sondeo de un change set que no termina', async () => {
  const aws = fakeAws({ stuckChangeSet: true });
  await assert.rejects(adapter(aws, { IAC_TIMEOUT_S: 0.1 }).apply(context()), { code: 'IAC_TIMEOUT' });
  assert.ok(!aws.calls.some((call) => call.name === 'ExecuteChangeSetCommand'));
});

test('el deadline también aborta una petición SDK pendiente', async () => {
  const aws = fakeAws();
  aws.cfn.send = (_command, { abortSignal }) => new Promise((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
  });
  await assert.rejects(adapter(aws, { IAC_TIMEOUT_S: 0.1 }).destroy(context()), { code: 'IAC_TIMEOUT' });
});

test('no detiene EC2 mientras el stack todavía se está actualizando', async () => {
  const aws = fakeAws({ existing: 'UPDATE_IN_PROGRESS' });
  await assert.rejects(adapter(aws, { IAC_TIMEOUT_S: 0.1 }).suspend(context()), { code: 'IAC_TIMEOUT' });
  assert.ok(!aws.calls.some((call) => call.name === 'StopInstancesCommand'));
});

test('cancelar deja de seguir el change set sin ordenar un borrado remoto', async () => {
  const aws = fakeAws({ stuckChangeSet: true });
  const controller = new AbortController();
  const send = aws.cfn.send;
  aws.cfn.send = async (command, options) => {
    const result = await send(command, options);
    if (command.constructor.name === 'DescribeChangeSetCommand') controller.abort(new OperationCancelled());
    return result;
  };
  await assert.rejects(adapter(aws).apply({ ...context(), signal: controller.signal }), OperationCancelled);
  assert.ok(!aws.calls.some((call) => ['DeleteStackCommand', 'ExecuteChangeSetCommand'].includes(call.name)));
});

test('la salida pública conserva identidad, SDK y hash del stack sin copiar campos privados', async () => {
  const aws = fakeAws({ changes: [add('DbInstance')] });
  const result = await adapter(aws).apply(context());
  const snapshot = { input, backend: { type: 'cloudformation', region: input.region, stack_name: stackName(input) }, image_version: '0.2.2' };
  const saved = publicDeployment({ ...result.outputs, password: 'PRIVATE_VALUE' }, result.tool_versions, snapshot);
  assert.equal(saved.outputs.stack_id, aws.stackArn);
  assert.equal(saved.outputs.stack_name, stackName(input));
  assert.equal(saved.tool_versions.cloudformation, 'AWS (administrado)');
  assert.equal(saved.tool_versions.aws_sdk, '3.1168.0');
  assert.match(saved.tool_versions.template_sha256, /^[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE_VALUE'));
  assert.throws(() => publicDeployment({ ...result.outputs, stack_name: 'otro-tenant' }, result.tool_versions, snapshot), { code: 'DEPLOYMENT_OUTPUTS' });
  assert.throws(() => publicDeployment({ ...result.outputs, stack_id: aws.stackArn.replace(input.region, 'us-east-1') }, result.tool_versions, snapshot), { code: 'DEPLOYMENT_OUTPUTS' });
});

test('una plantilla ausente se detecta en preflight antes de llamar a AWS', async () => {
  const aws = fakeAws();
  await assert.rejects(adapter(aws, { IAC_CFN_TEMPLATE: '/no-existe-plantilla-cfn.yaml' }).preflight(context()), { code: 'IAC_CONFIG' });
  assert.deepEqual(aws.calls, []);
});
