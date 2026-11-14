import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { bootstrapAdmin, tokenHash } from '../src/modules/auth/auth.service.js';
import { runOnce, recoverStale } from '../src/worker/queue.js';
import { OperationError, OperationCancelled } from '../src/worker/errors.js';
import { fakeCloudFormation } from './fixtures/fake-cloudformation.js';

const connection = process.env.TEST_DATABASE_URL;
test('creación: API, cola, worker, salud y persistencia con PostgreSQL real', { skip: !connection }, async (t) => {
  const url = new URL(connection);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /^\/platform_test[a-z0-9_]*$/.test(url.pathname),
    'Solo se permite una base local desechable llamada platform_test*');
  const directory = await mkdtemp(join(tmpdir(), 'attendance-create-'));
  const base = {
    project_name: 'attendance-platform', region: 'us-east-2', availability_zone: 'us-east-2a',
    vpc_id: 'vpc-00000000000000001', public_subnet_id: 'subnet-00000000000000001',
    private_subnet_id: 'subnet-00000000000000002', monitoring_security_group_id: 'sg-00000000000000004',
    ssm_endpoint_id: 'vpce-00000000000000001', backups_bucket: 'attendance-backups-test',
  };
  const ami = { frontend: 'ami-11111111111111111', backend: 'ami-22222222222222222', db: 'ami-33333333333333333' };
  const baseFile = join(directory, 'base.json');
  const amiFile = join(directory, 'amis.json');
  await writeFile(baseFile, JSON.stringify(base));
  await writeFile(amiFile, JSON.stringify({ region: base.region, image_version: '0.2.2', ami }));
  const config = readConfig({ DATABASE_URL: connection, NODE_ENV: 'test',
    DEPLOYMENT_BASE_OUTPUTS_FILE: baseFile, DEPLOYMENT_AMI_FILE: amiFile,
    DEPLOYMENT_STATE_BUCKET: 'attendance-state-test', DEPLOYMENT_WORK_DIR: join(directory, 'work'),
    HEALTH_SCRIPT: fileURLToPath(new URL('./fixtures/fake-health.sh', import.meta.url)), HEALTH_TIMEOUT_S: '1',
  });
  const pool = createPool(config);
  t.after(async () => { await pool.end(); await rm(directory, { recursive: true, force: true }); });
  // Comprobar las dos migraciones 003 ya publicadas sin cambiar sus checksums.
  for (const legacy of ['003_create_deployments.sql', '003_engines.sql', null]) {
    await t.test(`migraciones desde ${legacy ?? 'una base nueva'} conservan datos y checksums`, async () => {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      let savedId;
      if (legacy) {
        await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
        for (const filename of ['001_platform.sql', '002_backups.sql', legacy]) {
          const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
          await pool.query(sql);
          await pool.query('INSERT INTO schema_migrations(filename,checksum) VALUES ($1,$2)', [filename, createHash('sha256').update(sql).digest('hex')]);
        }
        const tenantId = randomUUID(), userId = randomUUID(), operationId = randomUUID();
        savedId = randomUUID();
        await pool.query("INSERT INTO tenants(id,tenant_id,env,name,contact_email,plan,engine) VALUES ($1,'legacy','test','Anterior','legacy@example.test','basic','terraform')", [tenantId]);
        await pool.query("INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,'Anterior','legacy@example.test','unused','platform_admin')", [userId]);
        await pool.query("INSERT INTO operations(id,tenant_id,type,initiated_by,status) VALUES ($1,$2,$3,$4,'succeeded')",
          [operationId, tenantId, legacy === '003_engines.sql' ? 'suspend' : 'create', userId]);
        await pool.query("INSERT INTO deployments(id,tenant_id,operation_id,engine,resources) VALUES ($1,$2,$3,'terraform','[{\"id\":\"i-existing\"}]')", [savedId, tenantId, operationId]);
      }
      assert.equal(await migrate(pool), legacy ? 2 : 5);
      assert.equal(await migrate(pool), 0, 'repetir no modifica nada');
      if (savedId) {
        const saved = (await pool.query('SELECT * FROM deployments WHERE id=$1', [savedId])).rows[0];
        assert.equal(saved.status, legacy === '003_engines.sql' ? 'suspended' : 'ready');
        assert.equal(saved.resources[0].id, 'i-existing');
        assert.deepEqual(saved.health, {});
        assert.ok(saved.log_ref.startsWith('operations/'));
        const original = await readFile(new URL(`../migrations/${legacy}`, import.meta.url), 'utf8');
        assert.equal((await pool.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [legacy])).rows[0].checksum,
          createHash('sha256').update(original).digest('hex'));
      }
    });
  }
  await bootstrapAdmin(pool, { name: 'Prueba', email: 'admin@example.test', password: 'password-para-pruebas' });
  const admin = (await pool.query("SELECT * FROM users WHERE role='platform_admin'")).rows[0];
  const cookie = `platform_session=${'a'.repeat(64)}`;
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [tokenHash('a'.repeat(64)), admin.id]);
  const input = { tenant_id: 'demo', name: 'Institución de prueba', env: 'test', engine: 'terraform', plan: 'basic', contact_email: 'owner@example.test' };
  const outputs = {
    instance_ids: { frontend: 'i-11111111111111111', backend: 'i-22222222222222222', db: 'i-33333333333333333' },
    private_ips: { frontend: '10.90.1.10', backend: '10.90.2.11', db: '10.90.2.12' },
    db_volume_id: 'vol-44444444444444444', urls: { frontend: 'http://198.51.100.20/' },
    secret: 'PRIVATE_ADAPTER_VALUE', unknown: { password: 'PRIVATE_ADAPTER_VALUE' },
  };
  let calls = [];
  let apply = async () => ({ status: 'succeeded' });
  const adapter = {
    preflight: async () => { calls.push('preflight'); },
    apply: async (context) => { calls.push(context); return apply(context); },
    outputs: async () => outputs,
    versions: async () => ({ terraform: '1.16.6', app: 'abcdef0123456789', password: 'PRIVATE_ADAPTER_VALUE' }),
  };
  const adapters = { terraform: adapter };
  const app = createApp({ pool, config, adapters });
  const api = (app = defaultApp) => request(app);
  const defaultApp = app;
  const creationServices = { prepareSecrets: async () => { calls.push('ssm'); } };
  const tenant = async (slug) => (await api().post('/api/v1/tenants').set('Cookie', cookie).send({ ...input, tenant_id: slug }).expect(201)).body;
  const enqueue = (id, target = app) => request(target).post(`/api/v1/tenants/${id}/operations`).set('Cookie', cookie).send({ type: 'create' });
  const run = (options = {}) => runOnce(pool, { config, adapters, creationServices, ...options });
  const state = async (id) => (await pool.query('SELECT * FROM tenants WHERE id=$1', [id])).rows[0];
  const operation = async (id) => (await pool.query('SELECT * FROM operations WHERE id=$1', [id])).rows[0];

  await t.test('un motor ausente rechaza antes de encolar o preparar secretos', async () => {
    const record = await tenant('sin-motor');
    const unavailable = createApp({ pool, config, adapters: {} });
    const result = await enqueue(record.id, unavailable).expect(503);
    assert.equal(result.body.error.code, 'ENGINE_NOT_AVAILABLE');
    assert.equal((await state(record.id)).status, 'draft');
    assert.equal(calls.length, 0);
    assert.equal((await pool.query('SELECT * FROM operations WHERE tenant_id=$1', [record.id])).rowCount, 0);
  });
  await t.test('valida permisos y no acepta variables o secretos enviados por el navegador', async () => {
    const record = await tenant('permisos');
    await request(app).post(`/api/v1/tenants/${record.id}/operations`).send({ type: 'create' }).expect(401);
    await api().post(`/api/v1/tenants/${record.id}/operations`).set('Cookie', cookie).send({ type: 'create', deployment: { password: 'no-aceptar' } }).expect(400);
    const userId = randomUUID();
    await pool.query("INSERT INTO users(id,name,email,password_hash,role,tenant_id) VALUES ($1,'Lector','reader@example.test','unused','tenant_admin',$2)", [userId, record.id]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [tokenHash('b'.repeat(64)), userId]);
    await api().post(`/api/v1/tenants/${record.id}/operations`).set('Cookie', `platform_session=${'b'.repeat(64)}`).send({ type: 'create' }).expect(403);
  });
  await t.test('configuración inválida se revierte sin encolar ni cambiar el tenant', async () => {
    const record = await tenant('sin-config');
    const incomplete = createApp({ pool, config: { ...config, DEPLOYMENT_STATE_BUCKET: '' }, adapters });
    await enqueue(record.id, incomplete).expect(503);
    assert.equal((await state(record.id)).status, 'draft');
  });
  await t.test('dos peticiones concurrentes crean un solo trabajo y nunca un tenant duplicado', async () => {
    const record = await tenant('concurrente');
    const responses = await Promise.all([enqueue(record.id), enqueue(record.id)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
    calls = [];
    await run();
    assert.equal((await state(record.id)).status, 'ready');
    assert.equal(calls.filter((v) => typeof v === 'object').length, 1);
  });
  await t.test('crea, comprueba salud y guarda solo outputs/versiones públicos', async () => {
    const record = await tenant('completo');
    const queued = (await enqueue(record.id).expect(202)).body;
    assert.equal((await state(record.id)).status, 'provisioning');
    calls = [];
    await run();
    assert.equal((await state(record.id)).status, 'ready');
    assert.deepEqual(calls.slice(0, 2), ['preflight', 'ssm']);
    const context = calls[2];
    assert.equal(context.backend.key, 'tenants/completo/test/terraform.tfstate');
    assert.equal(context.backend.use_lockfile, true);
    const variables = JSON.parse(await readFile(context.variableFile, 'utf8'));
    assert.ok(variables.cloud_init_template_path.endsWith('infra/cloud-init/user-data.yaml.tftpl'));
    await access(context.cloudInitTemplatePath);
    await access(join(context.moduleDirectory, 'versions.tf'));
    const saved = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rows[0];
    assert.equal(saved.status, 'ready');
    assert.equal(saved.health.status, 'healthy');
    assert.equal(saved.resources.length, 4);
    assert.equal(saved.tool_versions.app, 'abcdef0123456789');
    assert.equal(saved.outputs.urls.backend_health, 'http://198.51.100.20/core/api/v1/health');
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_'));
    assert.equal((await operation(queued.id)).progress, 100);
    const events = await api().get(`/api/v1/operations/${queued.id}/logs`).set('Cookie', cookie).expect(200);
    assert.ok(!JSON.stringify(events.body).includes('PRIVATE_'));
    await enqueue(record.id).expect(409);
  });
  await t.test('si falla salud conserva recursos y el reintento congela plan/AMI/backend', async () => {
    const record = await tenant('reintento');
    const queued = (await enqueue(record.id).expect(202)).body;
    process.env.FAKE_HEALTH_MODE = 'unhealthy';
    try { await run(); } finally { delete process.env.FAKE_HEALTH_MODE; }
    assert.equal((await state(record.id)).status, 'failed');
    const previous = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rows[0];
    assert.equal(previous.status, 'failed');
    assert.equal(previous.health.status, 'unhealthy');
    const original = (await operation(queued.id)).params.deployment;
    await writeFile(amiFile, JSON.stringify({ region: base.region, image_version: '9.9.9', ami: { ...ami, backend: 'ami-99999999999999999' } }));
    await pool.query("UPDATE plans SET sizing=jsonb_set(sizing,'{backend}','\"t3.large\"') WHERE code='basic'");
    config.DEPLOYMENT_STATE_BUCKET = 'otro-bucket-que-no-debe-usarse';
    const retry = await api().post(`/api/v1/operations/${queued.id}/retry`).set('Cookie', cookie).send({}).expect(202);
    assert.deepEqual(retry.body.params.deployment, original);
    calls = [];
    await run();
    assert.equal((await state(record.id)).status, 'ready');
    const repeated = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [retry.body.id])).rows[0];
    assert.deepEqual(repeated.outputs.instance_ids, previous.outputs.instance_ids);
    assert.equal(calls[2].backend.bucket, 'attendance-state-test');
    config.DEPLOYMENT_STATE_BUCKET = 'attendance-state-test';
    await writeFile(amiFile, JSON.stringify({ region: base.region, image_version: '0.2.2', ami }));
  });
  await t.test('cancelar en cola sale de provisioning y permite un reintento', async () => {
    const record = await tenant('cancelado-cola');
    const queued = (await enqueue(record.id).expect(202)).body;
    await api().post(`/api/v1/operations/${queued.id}/cancel`).set('Cookie', cookie).send({}).expect(200);
    assert.equal((await state(record.id)).status, 'failed');
    const retry = (await enqueue(record.id).expect(202)).body;
    assert.deepEqual(retry.params.deployment, queued.params.deployment);
    await run();
  });
  await t.test('cancelar durante apply detiene el recorrido y nunca marca ready', async () => {
    const record = await tenant('cancelado-activo');
    const queued = (await enqueue(record.id).expect(202)).body;
    let started;
    const signalStarted = new Promise((resolve) => { started = resolve; });
    apply = ({ signal }) => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('prueba agotada')), 3000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new OperationCancelled()); }, { once: true });
      started();
    });
    try {
      const running = run({ heartbeatMs: 25 });
      await signalStarted;
      await api().post(`/api/v1/operations/${queued.id}/cancel`).set('Cookie', cookie).send({}).expect(200);
      await running;
      assert.equal((await operation(queued.id)).status, 'cancelled');
      assert.equal((await state(record.id)).status, 'failed');
    } finally { apply = async () => ({ status: 'succeeded' }); }
  });
  await t.test('un apply fallido conserva el snapshot y no inventa un despliegue sano', async () => {
    const record = await tenant('apply-fallido');
    const queued = (await enqueue(record.id).expect(202)).body;
    apply = async () => { throw new OperationError('APPLY_FAILED', 'El motor no pudo crear recursos.'); };
    try { await run(); } finally { apply = async () => ({ status: 'succeeded' }); }
    assert.equal((await operation(queued.id)).status, 'failed');
    assert.equal((await state(record.id)).status, 'failed');
    assert.equal((await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rowCount, 0);
  });
  await t.test('recuperar un worker interrumpido también libera el estado del tenant', async () => {
    const record = await tenant('worker-caido');
    const queued = (await enqueue(record.id).expect(202)).body;
    await pool.query("UPDATE operations SET status='running', heartbeat_at=now()-interval '2 minutes' WHERE id=$1", [queued.id]);
    assert.equal(await recoverStale(pool, 30000), 1);
    assert.equal((await state(record.id)).status, 'failed');
    assert.equal((await operation(queued.id)).status, 'failed');
  });
  await t.test('un health check inválido nunca convierte el tenant en disponible', async () => {
    const record = await tenant('health-invalido');
    const queued = (await enqueue(record.id).expect(202)).body;
    process.env.FAKE_HEALTH_MODE = 'invalid';
    try { await run(); } finally { delete process.env.FAKE_HEALTH_MODE; }
    assert.equal((await state(record.id)).status, 'failed');
    assert.equal((await operation(queued.id)).status, 'failed');
    assert.equal((await pool.query('SELECT status FROM deployments WHERE operation_id=$1', [queued.id])).rows[0].status, 'failed');
  });
  await t.test('una cancelación al terminar salud gana a la publicación de ready', async () => {
    const record = await tenant('cancelacion-final');
    const queued = (await enqueue(record.id).expect(202)).body;
    await run({ creationServices: { ...creationServices, checkHealth: async () => {
      await pool.query('UPDATE operations SET cancel_requested=true WHERE id=$1', [queued.id]);
      return { status: 'healthy' };
    } } });
    assert.equal((await state(record.id)).status, 'failed');
    assert.equal((await operation(queued.id)).status, 'cancelled');
  });
  await t.test('el tenant administrador no puede leer operaciones de otra institución', async () => {
    const record = await tenant('privado');
    const queued = (await enqueue(record.id).expect(202)).body;
    await api().get(`/api/v1/operations/${queued.id}`).set('Cookie', `platform_session=${'b'.repeat(64)}`).expect(404);
    await run();
  });
  await t.test('preflight fallido no prepara secretos ni ejecuta apply', async () => {
    const record = await tenant('preflight-fallido');
    const queued = (await enqueue(record.id).expect(202)).body;
    const original = adapter.preflight;
    adapter.preflight = async () => { throw new OperationError('PREREQUISITE', 'Falta la herramienta configurada.'); };
    calls = [];
    try { await run(); } finally { adapter.preflight = original; }
    assert.deepEqual(calls, []);
    assert.equal((await operation(queued.id)).status, 'failed');
  });
  await t.test('outputs inválidos del adaptador no se publican como accesos del tenant', async () => {
    const record = await tenant('outputs-invalidos');
    const queued = (await enqueue(record.id).expect(202)).body;
    const original = adapter.outputs;
    adapter.outputs = async () => ({ ...outputs, urls: { frontend: 'javascript:alert(1)' } });
    try { await run(); } finally { adapter.outputs = original; }
    assert.equal((await state(record.id)).status, 'failed');
    assert.equal((await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rowCount, 0);
  });
  await t.test('perder la propiedad durante apply impide guardar o finalizar el despliegue ajeno', async () => {
    const record = await tenant('otro-worker');
    const queued = (await enqueue(record.id).expect(202)).body;
    const newOwner = randomUUID();
    apply = async () => {
      await pool.query('UPDATE operations SET worker_id=$2 WHERE id=$1', [queued.id, newOwner]);
      return { status: 'succeeded' };
    };
    try { await run(); } finally { apply = async () => ({ status: 'succeeded' }); }
    assert.equal((await operation(queued.id)).worker_id, newOwner);
    assert.equal((await operation(queued.id)).status, 'running');
    assert.equal((await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rowCount, 0);
    await pool.query("UPDATE operations SET heartbeat_at=now()-interval '2 minutes' WHERE id=$1", [queued.id]);
    await recoverStale(pool, 30000);
  });

  await t.test('el catálogo de motores y el detalle usan el mismo registro', async () => {
    const response = await api().get('/api/v1/engines').set('Cookie', cookie).expect(200);
    assert.equal(response.body.items.find((engine) => engine.code === 'terraform').available, true);
    assert.equal(response.body.items.find((engine) => engine.code === 'tofu').available, false);
    assert.equal(response.body.items.find((engine) => engine.code === 'pulumi').available, false);
  });

  await t.test('P2 y P6: create, suspend, resume y destroy con CLI simulado y la misma configuración', async () => {
    const realConfig = { ...config, TERRAFORM_BIN: fileURLToPath(new URL('./fixtures/fake-terraform.mjs', import.meta.url)),
      TOFU_BIN: fileURLToPath(new URL('./fixtures/fake-terraform.mjs', import.meta.url)), PYTHON_BIN: 'python-inexistente-prueba',
      IAC_RUNS_DIR: join(directory, 'p2-runs'), DEPLOYMENT_WORK_DIR: join(directory, 'p2-runs'),
    };
    const realApp = createApp({ pool, config: realConfig });
    const log = join(directory, 'p2-calls.jsonl');
    const previousEnv = Object.fromEntries(['FAKE_TF_LOG', 'FAKE_HEALTH_BASE', 'TF_WORKSPACE', 'TF_CLI_ARGS_plan'].map((key) => [key, process.env[key]]));
    process.env.FAKE_TF_LOG = log;
    process.env.FAKE_HEALTH_BASE = 'http://198.51.100.44';
    process.env.TF_WORKSPACE = 'workspace-que-no-debe-usarse';
    process.env.TF_CLI_ARGS_plan = '-lock=false';
    try {
      const record = await tenant('p2-integrado');
      const detail = await request(realApp).get(`/api/v1/tenants/${record.id}`).set('Cookie', cookie).expect(200);
      assert.equal(detail.body.creation.available, true);
      const created = (await enqueue(record.id, realApp).expect(202)).body;
      let secrets = 0;
      const services = { prepareSecrets: async () => { secrets++; } };
      await runOnce(pool, { config: realConfig, creationServices: services });
      assert.equal((await operation(created.id)).status, 'succeeded');
      assert.equal((await state(record.id)).status, 'ready');
      const deployed = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [created.id])).rows[0];
      assert.equal(deployed.tool_versions.terraform, '1.16.6');
      assert.equal(deployed.tool_versions.image_version, '0.2.2');
      assert.equal(deployed.tool_versions.provider_aws, '6.20.0');
      assert.equal(deployed.outputs.urls.frontend, 'http://198.51.100.44/');
      assert.ok(!JSON.stringify(deployed).includes('no-debe-aparecer'));
      const workDir = join(realConfig.DEPLOYMENT_WORK_DIR, record.tenant_id, record.env, record.engine);
      const firstVars = JSON.parse(await readFile(join(workDir, 'tenant.tfvars.json'), 'utf8'));
      assert.deepEqual(firstVars.backup, { schedule: 'weekly', retention_days: 28 });
      const firstBackend = await readFile(join(workDir, 'backend.hcl'), 'utf8');
      realConfig.IAC_STATE_BUCKET = 'bucket-nuevo-no-usar';
      realConfig.DEPLOYMENT_STATE_BUCKET = 'bucket-nuevo-no-usar';
      await pool.query("UPDATE plans SET limits='{\"max_students\":9999}' WHERE code='basic'");
      const send = (body) => request(realApp).post(`/api/v1/tenants/${record.id}/operations`).set('Cookie', cookie).send(body);
      const suspended = (await send({ type: 'suspend' }).expect(202)).body;
      await runOnce(pool, { config: realConfig, creationServices: services });
      assert.equal((await operation(suspended.id)).status, 'succeeded');
      assert.equal((await state(record.id)).status, 'suspended');
      assert.equal((await readFile(join(workDir, 'backend.hcl'), 'utf8')), firstBackend);
      const suspensionVars = JSON.parse(await readFile(join(workDir, 'tenant.tfvars.json'), 'utf8'));
      assert.equal(suspensionVars.suspended, true);
      assert.deepEqual(suspensionVars.limits, firstVars.limits);
      const suspension = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [suspended.id])).rows[0];
      assert.equal(suspension.status, 'suspended');
      assert.equal(suspension.outputs.urls.frontend, null);
      process.env.FAKE_HEALTH_BASE = 'http://198.51.100.55';
      const resumed = (await send({ type: 'resume' }).expect(202)).body;
      await runOnce(pool, { config: realConfig, creationServices: services });
      assert.equal((await operation(resumed.id)).status, 'succeeded');
      assert.equal((await state(record.id)).status, 'ready');
      const resumption = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [resumed.id])).rows[0];
      assert.equal(resumption.outputs.urls.frontend, 'http://198.51.100.55/');
      assert.equal(resumption.health.status, 'healthy');
      await send({ type: 'destroy', confirm: 'otro' }).expect(400);
      const destroyed = (await send({ type: 'destroy', confirm: record.tenant_id }).expect(202)).body;
      await runOnce(pool, { config: realConfig, creationServices: services });
      assert.equal((await operation(destroyed.id)).status, 'succeeded');
      assert.equal((await state(record.id)).status, 'deleted');
      const historical = (await pool.query('SELECT * FROM deployments WHERE tenant_id=$1', [record.id])).rows;
      assert.ok(historical.every((deployment) => deployment.status === 'deleted' && deployment.outputs.urls.frontend === null));
      assert.equal(secrets, 1, 'SSM se prepara únicamente al crear');
      const invocations = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(invocations.some((call) => call.args?.includes('-destroy')));
      assert.ok(invocations.every((call) => !call.args || (call.workspace === 'default' && !call.extraPlanArgs)));
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await t.test('CloudFormation: ciclo completo desde API sin bucket de tfstate ni archivos Terraform', async () => {
    const nativeConfig = { ...config, IAC_STATE_BUCKET: '', DEPLOYMENT_STATE_BUCKET: '', CFN_POLL_MS: 10 };
    const nativeApp = createApp({ pool, config: nativeConfig });
    const record = (await request(nativeApp).post('/api/v1/tenants').set('Cookie', cookie)
      .send({ ...input, tenant_id: 'cfn-integrado', engine: 'cloudformation' }).expect(201)).body;
    const send = (body) => request(nativeApp).post(`/api/v1/tenants/${record.id}/operations`).set('Cookie', cookie).send(body);
    const queued = (await send({ type: 'create' }).expect(202)).body;
    const snapshot = queued.params.deployment;
    assert.deepEqual(snapshot.backend, { type: 'cloudformation', region: 'us-east-2', stack_name: 'attendance-platform-cfn-integrado-test' });
    const aws = fakeCloudFormation(snapshot.input, { changes: [{ ResourceChange: {
      Action: 'Add', LogicalResourceId: 'DbInstance', ResourceType: 'AWS::EC2::Instance',
    } }] });
    nativeConfig.cfnClient = aws.cfn;
    nativeConfig.ec2Client = aws.ec2;
    let secrets = 0;
    const services = { prepareSecrets: async () => { secrets++; } };
    const runNative = () => runOnce(pool, { config: nativeConfig, creationServices: services });
    await runNative();
    assert.equal((await operation(queued.id)).status, 'succeeded');
    assert.equal((await state(record.id)).status, 'ready');
    const saved = (await pool.query('SELECT * FROM deployments WHERE operation_id=$1', [queued.id])).rows[0];
    assert.equal(saved.outputs.stack_id, aws.stackArn);
    assert.equal(saved.tool_versions.cloudformation, 'AWS (administrado)');
    assert.equal(saved.tool_versions.aws_sdk, '3.1168.0');
    assert.match(saved.tool_versions.template_sha256, /^[a-f0-9]{12}$/);
    const workDir = join(nativeConfig.DEPLOYMENT_WORK_DIR, record.tenant_id, record.env, record.engine);
    await assert.rejects(access(join(workDir, 'backend.hcl')), { code: 'ENOENT' });
    await assert.rejects(access(join(workDir, 'tenant.tfvars.json')), { code: 'ENOENT' });
    const suspended = (await send({ type: 'suspend' }).expect(202)).body;
    await runNative();
    assert.equal((await operation(suspended.id)).status, 'succeeded');
    assert.equal((await state(record.id)).status, 'suspended');
    const resumed = (await send({ type: 'resume' }).expect(202)).body;
    await runNative();
    assert.equal((await operation(resumed.id)).status, 'succeeded');
    const detail = (await request(nativeApp).get(`/api/v1/tenants/${record.id}`).set('Cookie', cookie).expect(200)).body;
    assert.equal(detail.deployments[0].outputs.urls.frontend, 'http://198.51.100.41/');
    const destroyed = (await send({ type: 'destroy', confirm: record.tenant_id }).expect(202)).body;
    await runNative();
    assert.equal((await operation(destroyed.id)).status, 'succeeded');
    assert.equal((await state(record.id)).status, 'deleted');
    assert.equal(secrets, 1);
  });
});
