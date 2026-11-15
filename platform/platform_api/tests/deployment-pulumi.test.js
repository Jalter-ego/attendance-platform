import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, validateSnapshot } from '../src/modules/deployments/deployment-config.js';
import { prepareDeploymentContext } from '../src/worker/services/deployment-context.js';
import { redact } from '../src/lib/redact.js';

test('Pulumi congela su backend S3 por tenant y rechaza cambiar su identidad al reintentar', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pulumi-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tenant = { tenant_id: 'colegio-demo', name: 'Colegio', env: 'test', region: 'us-east-2',
    engine: 'pulumi', plan: 'basic', contact_email: 'admin@example.test', timezone: 'America/La_Paz' };
  const base = { project_name: 'attendance-platform', region: tenant.region, availability_zone: 'us-east-2a',
    vpc_id: 'vpc-00000000000000001', public_subnet_id: 'subnet-00000000000000001',
    private_subnet_id: 'subnet-00000000000000002', monitoring_security_group_id: 'sg-00000000000000001',
    ssm_endpoint_id: 'vpce-00000000000000001' };
  const plan = { sizing: { frontend: 't3.micro', backend: 't3.micro', db: 't3.micro', db_disk_gb: 10 }, limits: {} };
  const config = { IAC_BASE_OUTPUTS: join(directory, 'base.json'), IAC_AMI_IDS: join(directory, 'ami.json'),
    IAC_STATE_BUCKET: 'attendance-state-test', IAC_RUNS_DIR: directory };
  await writeFile(config.IAC_BASE_OUTPUTS, JSON.stringify(base));
  await writeFile(config.IAC_AMI_IDS, JSON.stringify({ region: tenant.region, image_version: '0.3.0',
    ami: { frontend: 'ami-11111111111111111', backend: 'ami-22222222222222222', db: 'ami-33333333333333333' } }));
  const snapshot = await buildSnapshot(tenant, plan, config);
  assert.deepEqual(snapshot.backend, { type: 'pulumi', bucket: config.IAC_STATE_BUCKET, region: tenant.region,
    url: 's3://attendance-state-test/pulumi', stack_name: 'attendance-platform-colegio-demo-test' });
  for (const altered of [ { stack_name: 'otro-tenant' }, { url: 's3://otro-bucket/pulumi' }, { type: 'cloudformation' } ]) {
    assert.throws(() => validateSnapshot({ ...snapshot, backend: { ...snapshot.backend, ...altered } }, tenant),
      (error) => ['DEPLOYMENT_IDENTITY', 'DEPLOYMENT_CONFIG'].includes(error.code));
  }
  const context = await prepareDeploymentContext({ config, tenant, snapshot,
    operation: { id: 'test' }, report: async () => {} });
  assert.equal(context.variableFile, undefined, 'Pulumi no debe recibir archivos tfvars');
  assert.equal(context.backendFile, undefined, 'Pulumi no debe escribir configuración backend de Terraform');
});

test('la contraseña del backend Pulumi se oculta en logs', () => {
  assert.equal(redact('PULUMI_CONFIG_PASSPHRASE=secreto-que-no-debe-salir'), 'PULUMI_CONFIG_PASSPHRASE=[REDACTED]');
});
