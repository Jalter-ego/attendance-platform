// Pruebas del adaptador Pulumi (P2, D3) sin AWS: CLI simulado (fixtures/fake-pulumi.mjs).
// Ejecutar con `pnpm test:pulumi`. El programa infra/pulumi/tenant tiene sus propias
// pruebas con los mocks de Pulumi (`pnpm --dir infra/pulumi/tenant test`).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import {
  backendUrl,
  createPulumiAdapter,
  explainPulumiError,
  programInput,
  qualifiedStack,
  stackInventory,
  summarizePreview,
} from '../src/engines/pulumi.js';
import { BACKUP_BY_PLAN } from '../src/engines/tenant-input.js';
import { engineAvailable, getAdapter } from '../src/engines/adapter.js';
import { supportsRealLifecycle } from '../src/engines/lifecycle-capabilities.js';
import { publicDeployment, validateSnapshot } from '../src/modules/deployments/deployment-config.js';
import { runPulumiLifecycle } from '../src/worker/services/pulumi-lifecycle.js';

const fakePulumi = fileURLToPath(new URL('./fixtures/fake-pulumi.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'p2-pulumi-'));
const programDir = join(root, 'program');
await mkdir(join(programDir, 'node_modules', '@pulumi', 'aws'), { recursive: true });
await writeFile(join(programDir, 'index.js'), '// programa simulado\n');
await writeFile(join(programDir, 'node_modules', '@pulumi', 'aws', 'package.json'), '{"version":"7.55.0"}');
after(() => rm(root, { recursive: true, force: true }));

const input = {
  tenant_id: 'demo-pulumi',
  name: 'Colegio Demo',
  env: 'test',
  region: 'us-east-2',
  plan: 'basic',
  engine: 'pulumi',
  contact_email: 'admin@example.com',
  timezone: 'America/La_Paz',
  sizing: { frontend: 't3.micro', backend: 't3.micro', db: 't3.micro', db_disk_gb: 10 },
  limits: { max_students: 100 },
  backup: BACKUP_BY_PLAN.basic,
  ami: { frontend: 'ami-0aaaaaaaaaaaaaaa1', backend: 'ami-0aaaaaaaaaaaaaaa2', db: 'ami-0aaaaaaaaaaaaaaa3' },
  suspended: false,
  image: { version: '0.2.2', git_commit: '25155ea' },
  base: {
    project_name: 'attendance-platform', region: 'us-east-2', availability_zone: 'us-east-2a',
    vpc_id: 'vpc-0123456789abcdef0', public_subnet_id: 'subnet-0aaaaaaaaaaaaaaa1', private_subnet_id: 'subnet-0bbbbbbbbbbbbbbb2',
    monitoring_security_group_id: 'sg-0ccccccccccccccc3', ssm_endpoint_id: 'vpce-0ddddddddddddddd4', backups_bucket: 'backups-bucket',
  },
};

let runs;
beforeEach(async () => {
  runs = await mkdtemp(join(root, 'runs-'));
  delete process.env.FAKE_PULUMI_FAIL;
  delete process.env.FAKE_PULUMI_REPLACE_VOLUME;
});

function config(settings = {}) {
  return {
    ...readConfig({ DATABASE_URL: 'postgresql://unused' }),
    PULUMI_BIN: fakePulumi,
    IAC_PULUMI_DIR: programDir,
    IAC_RUNS_DIR: runs,
    IAC_STATE_BUCKET: 'attendance-platform-tfstate-123456789012',
    PULUMI_CONFIG_PASSPHRASE: 'frase-de-prueba',
    ...settings,
  };
}

function context(events = [], overrides = {}) {
  return {
    input,
    logRef: 'operations/test',
    report: async (message, options = {}) => { events.push({ message, ...options }); },
    ...overrides,
  };
}

const workDir = () => join(runs, input.tenant_id, input.env, 'pulumi');
const calls = async () => (await readFile(join(workDir(), '.fake-pulumi-calls.log'), 'utf8')).trim().split('\n');
const fakeState = async () => JSON.parse(await readFile(join(workDir(), '.fake-pulumi.json'), 'utf8'));

test('backend S3 con prefijo pulumi/, stack por tenant y entrada sin datos de imagen', () => {
  assert.equal(backendUrl(config(), input), 's3://attendance-platform-tfstate-123456789012/pulumi?region=us-east-2');
  assert.equal(backendUrl(config({ PULUMI_BACKEND_URL: 'file:///tmp/state' }), input), 'file:///tmp/state');
  assert.equal(backendUrl(config({ IAC_STATE_BUCKET: '' }), input), null);
  assert.equal(qualifiedStack(input), 'organization/attendance-tenant/demo-pulumi-test');
  const program = programInput(input);
  assert.equal(program.engine, 'pulumi');
  assert.equal(program.image, undefined);
  assert.ok(engineAvailable('pulumi'));
  assert.equal(getAdapter('pulumi', config()).engine, 'pulumi');
  assert.ok(supportsRealLifecycle('pulumi', 'suspend'));
  assert.ok(!supportsRealLifecycle('pulumi', 'plan-change'));
});

test('summarizePreview cuenta cambios, ignora el stack/proveedor y detecta el disco de datos', () => {
  const step = (op, type, name) => ({ op, urn: `urn:pulumi:demo::attendance-tenant::${type}::${name}` });
  const summary = summarizePreview({ steps: [
    step('create', 'pulumi:pulumi:Stack', 'root'),
    step('same', 'pulumi:providers:aws', 'tenant'),
    step('create', 'aws:ec2/instance:Instance', 'db'),
    step('update', 'aws:ec2transitgateway/instanceState:InstanceState', 'state-db'),
    step('create-replacement', 'aws:ebs/volume:Volume', 'db-data'),
    step('delete-replaced', 'aws:ebs/volume:Volume', 'db-data'),
  ] });
  assert.deepEqual(summary.totals, { create: 1, update: 1, delete: 0, replace: 1 });
  assert.deepEqual(summary.data_volumes_deleted, ['db-data']);
  assert.ok(summary.lines.includes('Se reemplazará: Volume db-data'));
  assert.deepEqual(summarizePreview({ steps: [step('same', 'aws:ebs/volume:Volume', 'db-data')] }).data_volumes_deleted, []);
});

test('crear: stack, configuración por stdin, preview, up, outputs y versiones', async () => {
  const events = [];
  const result = await createPulumiAdapter(config()).apply(context(events));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs.stack_name, 'organization/attendance-tenant/demo-pulumi-test');
  assert.match(result.outputs.urls.frontend, /^http:\/\/3\.15\.0\.\d+\/$/);
  assert.equal(result.resources.length, 4);
  assert.equal(result.tool_versions.pulumi, 'v3.999.0');
  assert.equal(result.tool_versions.provider_aws, '7.55.0');
  assert.equal(result.tool_versions.image_version, '0.2.2');
  assert.equal(result.tool_versions.module, 'infra/pulumi/tenant');
  assert.deepEqual(result.preview.totals, { create: 7, update: 0, delete: 0, replace: 0 });

  const log = await calls();
  assert.ok(log.every((line) => line.endsWith('passphrase=set')));
  assert.ok(log.some((line) => line.startsWith('stack select organization/attendance-tenant/demo-pulumi-test --create --secrets-provider passphrase')));
  assert.ok(log.some((line) => line.startsWith('up --yes --skip-preview')));
  // La configuración viaja por stdin, no en los argumentos.
  assert.ok(!log.some((line) => line.includes('Colegio')));
  const stored = JSON.parse((await fakeState()).stacks[qualifiedStack(input)].config['attendance-tenant:input']);
  assert.equal(stored.tenant_id, 'demo-pulumi');
  assert.equal(stored.suspended, false);

  const project = JSON.parse(await readFile(join(workDir(), 'Pulumi.yaml'), 'utf8'));
  assert.equal(project.backend.url, 's3://attendance-platform-tfstate-123456789012/pulumi?region=us-east-2');
  assert.equal(project.main, programDir.replaceAll('\\', '/'));
  assert.ok(events.some(({ stage }) => stage === 'Aplicando cambios'));
  assert.ok(!events.some(({ message }) => message.includes('frase-de-prueba')));
});

test('sin cambios no ejecuta up (reintento idempotente)', async () => {
  const adapter = createPulumiAdapter(config());
  await adapter.apply(context());
  const before = (await calls()).filter((line) => line.startsWith('up ')).length;
  const events = [];
  await adapter.apply(context(events));
  assert.equal((await calls()).filter((line) => line.startsWith('up ')).length, before);
  assert.ok(events.some(({ stage }) => stage === 'Sin cambios pendientes'));
});

test('un preview que reemplaza el disco de datos se detiene sin aplicar', async () => {
  const adapter = createPulumiAdapter(config());
  await adapter.apply(context());
  process.env.FAKE_PULUMI_REPLACE_VOLUME = '1';
  await assert.rejects(adapter.apply(context()), { code: 'DATA_LOSS_BLOCKED' });
  assert.equal((await calls()).filter((line) => line.startsWith('up ')).length, 1);
});

test('suspender y reanudar son declarativos (InstanceState) y recalculan la URL', async () => {
  const adapter = createPulumiAdapter(config());
  const created = await adapter.apply(context());
  const suspended = await adapter.suspend(context());
  assert.equal(suspended.outputs.urls.frontend, null);
  assert.deepEqual(suspended.preview.totals, { create: 0, update: 3, delete: 0, replace: 0 });
  const resumed = await adapter.resume(context());
  assert.match(resumed.outputs.urls.frontend, /^http:\/\/3\.15\.0\.\d+\/$/);
  assert.notEqual(resumed.outputs.urls.frontend, created.outputs.urls.frontend);
});

test('un fallo de up se traduce a un mensaje comprensible', async () => {
  process.env.FAKE_PULUMI_FAIL = 'vcpu';
  await assert.rejects(createPulumiAdapter(config()).apply(context()), (error) => {
    assert.equal(error.code, 'ENGINE_FAILED');
    assert.match(error.message, /cuota de vCPU/);
    return true;
  });
  assert.match(explainPulumiError(['error: the stack is currently locked by 1 lock(s)']), /bloqueado/);
  assert.match(explainPulumiError(['error: incorrect passphrase']), /PULUMI_CONFIG_PASSPHRASE/);
  assert.match(explainPulumiError(['error: unable to replace resource db-data as it is currently marked for protection']), /disco de datos/);
  assert.match(explainPulumiError(['error: The AWS profile "x" was not found.']), /credenciales/);
});

test('eliminar exige la misma vista previa, libera la protección del disco y destruye', async () => {
  const adapter = createPulumiAdapter(config());
  await adapter.apply(context());
  const preview = await adapter.preview(context(), { destroy: true });
  assert.equal(preview.stack, 'organization/attendance-tenant/demo-pulumi-test');
  assert.equal(preview.resources.length, 7);
  assert.ok(preview.lines.some((line) => line.includes('disco de datos')));
  await assert.rejects(adapter.destroy(context(), { expectedPreview: { fingerprint: 'f'.repeat(64) } }), { code: 'IAC_PREVIEW_STALE' });
  const result = await adapter.destroy(context(), { expectedPreview: preview });
  assert.equal(result.status, 'succeeded');
  const log = await calls();
  const unprotect = log.findIndex((line) => line.startsWith('state unprotect --all --yes'));
  const destroy = log.findIndex((line) => line.startsWith('destroy --yes'));
  assert.ok(unprotect >= 0 && destroy > unprotect);
  assert.deepEqual((await fakeState()).stacks[qualifiedStack(input)].resources, []);
  // Un stack inexistente no tiene nada que eliminar.
  const missing = await adapter.preview(context([], { input: { ...input, tenant_id: 'otro-tenant' } }), { destroy: true });
  assert.equal(missing.stack, null);
});

test('detecta configuración incompleta antes de llamar a Pulumi', async () => {
  await assert.rejects(createPulumiAdapter(config({ PULUMI_CONFIG_PASSPHRASE: '' })).preflight(context()), /PULUMI_CONFIG_PASSPHRASE/);
  await assert.rejects(createPulumiAdapter(config({ IAC_STATE_BUCKET: '' })).preflight(context()), /IAC_STATE_BUCKET/);
  await assert.rejects(createPulumiAdapter(config({ IAC_PULUMI_DIR: join(root, 'no-existe') })).preflight(context()), /IAC_PULUMI_DIR/);
  // Con KMS no hace falta frase.
  await createPulumiAdapter(config({ PULUMI_CONFIG_PASSPHRASE: '', PULUMI_SECRETS_PROVIDER: 'awskms://alias/attendance' })).preflight(context());
});

test('snapshot y salida pública de P6 conservan la identidad del stack Pulumi', () => {
  const tenant = { tenant_id: input.tenant_id, env: 'test', engine: 'pulumi', region: 'us-east-2' };
  const { image, suspended, ...rest } = input;
  const snapshot = validateSnapshot({
    version: 1,
    input: { ...rest, suspended: false },
    backend: { type: 'pulumi', url: backendUrl(config(), input), stack: qualifiedStack(input) },
    image_version: '0.2.2',
  }, tenant);
  assert.throws(() => validateSnapshot({ ...snapshot, backend: { ...snapshot.backend, stack: 'organization/attendance-tenant/otro-test' } }, tenant), { code: 'DEPLOYMENT_IDENTITY' });
  const raw = {
    urls: { frontend: 'http://3.15.0.11/' },
    instance_ids: { frontend: 'i-0aaaaaaaaaaaaaaa1', backend: 'i-0aaaaaaaaaaaaaaa2', db: 'i-0aaaaaaaaaaaaaaa3' },
    private_ips: { frontend: '10.0.1.10', backend: '10.0.2.10', db: '10.0.2.11' },
    db_volume_id: 'vol-0123456789abcdef0', stack_name: qualifiedStack(input),
  };
  const deployment = publicDeployment(raw, { pulumi: 'v3.272.0', provider_aws: '7.55.0' }, snapshot);
  assert.equal(deployment.outputs.stack_name, qualifiedStack(input));
  assert.equal(deployment.tool_versions.pulumi, 'v3.272.0');
  assert.throws(() => publicDeployment({ ...raw, stack_name: 'otro' }, {}, snapshot), { code: 'DEPLOYMENT_OUTPUTS' });
});

test('el ciclo de P6 suspende con el mismo backend, exige vista previa y verifica salud', async () => {
  const tenant = { id: 'uuid-1', tenant_id: input.tenant_id, env: 'test', engine: 'pulumi', region: 'us-east-2' };
  const state = { backend: 'file:///estado-del-create', stack: qualifiedStack(input) };
  const deployment = { ami: input.ami, outputs: { state }, tool_versions: { image_version: '0.2.2' } };
  const seen = [];
  const fakeAdapter = {
    async suspend(ctx) { seen.push(ctx); return { outputs: { stack_name: state.stack, urls: { frontend: null } }, resources: [], tool_versions: {} }; },
    async resume(ctx) {
      seen.push(ctx);
      return { outputs: { stack_name: state.stack, urls: { frontend: 'http://3.15.0.12/', frontend_health: 'http://3.15.0.12/healthz', backend_health: 'http://3.15.0.12/core/api/v1/health' } }, resources: [], tool_versions: {} };
    },
    async preview() { return { stack: state.stack, lines: ['Se eliminará: Volume db-data'], fingerprint: 'a'.repeat(64) }; },
  };
  const run = (type, extra = {}) => runPulumiLifecycle({
    config: config({ PLATFORM_DEPLOY_MODE: 'integration', PLATFORM_WORK_ROOT: runs }),
    tenant, plan: {}, deployment, operation: { id: 'op-1', type }, report: async () => {}, ...extra,
  }, {
    makeAdapter: () => fakeAdapter,
    loadInput: async () => ({ ...input }),
    pinInput: async (_config, _tenant, value) => ({ ami: value.ami, image: value.image }),
    checkHealth: async (targets) => { seen.push(targets); },
  });

  const suspended = await run('suspend');
  assert.equal(suspended.tenantStatus, 'suspended');
  assert.equal(seen[0].backend.url, 'file:///estado-del-create');
  assert.equal(seen[0].directory, join(runs, input.tenant_id, 'test', 'pulumi'));
  assert.deepEqual(suspended.deployment.outputs.state, state);
  assert.equal(suspended.deployment.outputs.health.frontend, 'paused');

  const resumed = await run('resume');
  assert.equal(resumed.tenantStatus, 'ready');
  assert.deepEqual(seen.at(-1), { frontend: 'http://3.15.0.12/healthz', backend: 'http://3.15.0.12/core/api/v1/health' });

  const preview = await run('preview-delete');
  assert.equal(preview.result.fingerprint, 'a'.repeat(64));
  assert.equal(preview.result.downtime, true);
  await assert.rejects(run('delete'), { code: 'IAC_PREVIEW_REQUIRED' });
  await assert.rejects(run('plan-change'), { code: 'IAC_ENGINE_UNSUPPORTED' });
});
