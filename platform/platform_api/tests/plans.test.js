// Catálogo de planes (P4 · F2): API HTTP + migración 004 contra un PostgreSQL REAL.
// Crea una base desechable, aplica todas las migraciones y la borra al terminar.
//
//   TEST_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:5544/postgres pnpm test:plans
//
// Sin TEST_DATABASE_URL las pruebas se omiten (el resto de la suite no necesita base).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { tokenHash } from '../src/modules/auth/auth.service.js';
import { buildTenantInput } from '../src/engines/tenant-input.js';
import { runOnce } from '../src/worker/queue.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : 'define TEST_DATABASE_URL para probar contra PostgreSQL';
const DB_NAME = `plans_test_${randomBytes(4).toString('hex')}`;

let admin;
let pool;
let app;
let config;
let adminCookie;
let viewerCookie;
const engineDirectories = [];

const sizing = { frontend: 't3.micro', backend: 't3.micro', db: 't3.micro', db_disk_gb: 10 };
const newPlan = {
  code: 'escuela-rural',
  name: 'Escuela rural',
  description: 'Para escuelas de una sola aula',
  sizing,
  limits: { max_students: 50, max_teachers: 3 },
  backup: { schedule: 'weekly', retention_days: 28 },
};

async function session(role, tenantId = null) {
  const user = randomUUID();
  await pool.query(
    "INSERT INTO users(id, name, email, password_hash, role, tenant_id) VALUES ($1, 'Prueba', $2, 'x', $3, $4)",
    [user, `${user}@example.com`, role, tenantId],
  );
  const token = randomBytes(24).toString('hex');
  await pool.query(
    "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [tokenHash(token), user],
  );
  return `platform_session=${token}`;
}

async function addTenant(tenantId, plan, status = 'ready') {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id, tenant_id, env, name, contact_email, plan, engine, status) VALUES ($1, $2, 'test', $2, 'a@example.com', $3, 'terraform', $4)",
    [id, tenantId, plan, status],
  );
  return id;
}

const get = (path, cookie = adminCookie) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const send = (method, path, body, cookie = adminCookie) =>
  request(app)[method](`/api/v1${path}`).set('Cookie', cookie).send(body);
const planBody = (plan) => ({
  name: plan.name,
  description: plan.description,
  sizing: plan.sizing,
  limits: plan.limits,
  backup: plan.backup,
  version: plan.version,
});

describe('catálogo de planes', { skip }, () => {
  before(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DB_NAME}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrate(pool);
    config = readConfig({ DATABASE_URL: url.toString(), PLATFORM_DEPLOY_MODE: 'local' });
    app = createApp({ pool, config });
    adminCookie = await session('platform_admin');
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin?.end();
    for (const directory of engineDirectories) await rm(directory, { recursive: true, force: true });
  });

  test('GET /plans: semilla F3 con respaldo, versión y uso', async () => {
    const response = await get('/plans');
    assert.equal(response.status, 200);
    const plans = Object.fromEntries(response.body.items.map((plan) => [plan.code, plan]));
    assert.deepEqual(Object.keys(plans), ['basic', 'standard', 'advanced']);
    assert.deepEqual(plans.basic.backup, { schedule: 'weekly', retention_days: 28 });
    assert.deepEqual(plans.standard.backup, { schedule: 'daily', retention_days: 14 });
    assert.deepEqual(plans.advanced.backup, { schedule: 'daily', retention_days: 30 });
    assert.equal(plans.advanced.limits.max_students, 5000);
    assert.equal(plans.standard.sizing.db_disk_gb, 50);
    assert.equal(plans.basic.version, 1);
    assert.deepEqual(plans.basic.tenants, { total: 0, outdated: 0 });
    assert.equal(plans.basic.description, 'Para instituciones pequeñas');
  });

  test('POST /plans crea un plan; el código no se repite', async () => {
    const created = await send('post', '/plans', newPlan);
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);
    assert.deepEqual(created.body.limits, { max_students: 50, max_teachers: 3 });
    const again = await send('post', '/plans', newPlan);
    assert.equal(again.status, 409);
  });

  test('validación con mensajes legibles (mismas reglas que el módulo de P1)', async () => {
    const cases = [
      [{ ...newPlan, code: 'Mal Codigo' }, 'code'],
      [{ ...newPlan, code: 'x1', sizing: { ...sizing, db: 'm5.large' } }, 'sizing.db'],
      [{ ...newPlan, code: 'x2', sizing: { ...sizing, db_disk_gb: 9 } }, 'sizing.db_disk_gb'],
      [{ ...newPlan, code: 'x3', sizing: { ...sizing, db_disk_gb: 10.5 } }, 'sizing.db_disk_gb'],
      [{ ...newPlan, code: 'x4', sizing: { ...sizing, db_disk_gb: 5000 } }, 'sizing.db_disk_gb'],
      [{ ...newPlan, code: 'x5', backup: { schedule: 'daily', retention_days: 7 } }, 'backup'],
      [{ ...newPlan, code: 'x6', limits: { max_students: 0 } }, 'limits.max_students'],
      [{ ...newPlan, code: 'x7', limits: { max_storage: 5 } }, 'limits'],
      [{ ...newPlan, code: 'x8', name: '' }, 'name'],
    ];
    for (const [body, field] of cases) {
      const response = await send('post', '/plans', body);
      assert.equal(response.status, 400, `debería rechazar ${field}`);
      assert.ok(
        response.body.error.fields.some((issue) => issue.path === field || issue.path.startsWith(`${field}.`) || (field === 'limits' && issue.path === '')),
        `${field}: ${JSON.stringify(response.body.error.fields)}`,
      );
    }
    assert.match(
      (await send('post', '/plans', cases[5][0])).body.error.fields[0].message,
      /semanal con 28 días/,
    );
  });

  test('un tenant guarda la copia del plan vigente al registrarse', async () => {
    const response = await send('post', '/tenants', {
      tenant_id: 'colegio-a',
      name: 'Colegio A',
      plan: 'standard',
      engine: 'terraform',
      contact_email: 'a@example.com',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.plan_snapshot.version, 1);
    assert.equal(response.body.plan_snapshot.limits.max_students, 1000);
    const missing = await send('post', '/tenants', {
      tenant_id: 'colegio-b',
      name: 'Colegio B',
      plan: 'no-existe',
      engine: 'terraform',
      contact_email: 'b@example.com',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'PLAN_NOT_FOUND');
    const custom = await send('post', '/tenants', {
      tenant_id: 'escuelita',
      name: 'Escuelita',
      plan: 'escuela-rural',
      engine: 'terraform',
      contact_email: 'c@example.com',
    });
    assert.equal(custom.status, 201, 'acepta un plan creado en el catálogo');
  });

  test('PUT /plans/:code sube la versión y NO cambia los tenants existentes (aviso)', async () => {
    const tenantId = await addTenant('colegio-viejo', 'standard');
    const current = (await get('/plans/standard')).body;
    assert.equal(current.tenants.total, 2);
    const response = await send('put', '/plans/standard', {
      ...planBody(current),
      limits: { ...current.limits, max_students: 2000 },
      backup: { schedule: 'weekly', retention_days: 28 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.changed, true);
    assert.equal(response.body.plan.version, 2);
    assert.equal(response.body.unchanged_tenants, 2);
    assert.match(response.body.warning, /siguen con la versión anterior/);
    assert.deepEqual(response.body.plan.tenants, { total: 2, outdated: 2 });

    // Lo que desplegaría un suspend/resume de ese tenant: su copia, no el plan nuevo.
    const { rows } = await pool.query(
      'SELECT t.*, row_to_json(p) AS plan_row FROM tenants t JOIN plans p ON p.code = t.plan WHERE t.id = $1',
      [tenantId],
    );
    const snapshot = rows[0].plan_snapshot;
    assert.equal(snapshot.limits.max_students, 1000);
    assert.equal(rows[0].plan_row.limits.max_students, 2000);
    const config = await engineConfig();
    const input = await buildTenantInput(config, rows[0], rows[0].plan_row, {
      suspended: true,
    });
    assert.equal(input.limits.max_students, 1000, 'el motor recibe la copia (v1), no el plan editado');
    assert.equal(input.plan_version, 1);
    assert.deepEqual(input.backup, { schedule: 'daily', retention_days: 14 });

    // El flujo real de P6 usa buildSnapshot al encolar, no buildTenantInput.
    // Verificar el primer despliegue de un tenant registrado antes de editar el plan.
    const draft = (await pool.query("SELECT id FROM tenants WHERE tenant_id='colegio-a'")).rows[0];
    const integrationApp = createApp({ pool, config });
    const creation = await request(integrationApp)
      .post(`/api/v1/tenants/${draft.id}/operations`).set('Cookie', adminCookie)
      .send({ type: 'create' });
    assert.equal(creation.status, 202, JSON.stringify(creation.body));
    assert.equal(creation.body.params.deployment.input.plan_version, 1);
    assert.equal(creation.body.params.deployment.input.limits.max_students, 1000);
    assert.deepEqual(creation.body.params.deployment.input.backup, { schedule: 'daily', retention_days: 14 });
    const cancelled = await request(integrationApp)
      .post(`/api/v1/operations/${creation.body.id}/cancel`).set('Cookie', adminCookie).send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');

    // Un tenant nuevo sí toma la versión 2.
    await addTenant('colegio-nuevo', 'standard');
    const plan = (await get('/plans/standard')).body;
    assert.deepEqual(plan.tenants, { total: 3, outdated: 2 });
    assert.equal(plan.tenant_list.find((t) => t.tenant_id === 'colegio-nuevo').plan_version, 2);
  });

  test('PUT sin cambios no sube la versión; con versión vieja responde 409', async () => {
    const current = (await get('/plans/basic')).body;
    const same = await send('put', '/plans/basic', planBody(current));
    assert.equal(same.status, 200);
    assert.equal(same.body.changed, false);
    assert.equal(same.body.plan.version, current.version);
    assert.equal(same.body.warning, null);

    await send('put', '/plans/basic', { ...planBody(current), description: 'Nueva descripción' });
    const stale = await send('put', '/plans/basic', { ...planBody(current), name: 'Otro nombre' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PLAN_CHANGED');
  });

  test('DELETE solo si ningún tenant lo usa', async () => {
    const used = await send('delete', '/plans/standard', {});
    assert.equal(used.status, 409);
    assert.equal(used.body.error.code, 'PLAN_IN_USE');
    await send('post', '/plans', { ...newPlan, code: 'temporal', name: 'Temporal' });
    assert.equal((await send('delete', '/plans/temporal', {})).status, 204);
    assert.equal((await get('/plans/temporal')).status, 404);
  });

  test('el worker aplica la revisión confirmada aunque el catálogo vuelva a cambiar', async () => {
    const code = 'para-confirmar';
    const tenantId = await addTenant('tienda-confirmar', 'basic');
    const path = `/tenants/${tenantId}/plan-change`;
    const created = await send('post', '/plans', { ...newPlan, code });
    assert.equal(created.status, 201);
    const execute = () => runOnce(pool, { config, stepDelayMs: 0 });

    const preview = await send('post', `${path}/preview`, { plan: code });
    assert.equal(preview.status, 202);
    await execute();
    const changed = await send('put', `/plans/${code}`, {
      ...planBody(created.body), backup: { schedule: 'daily', retention_days: 30 },
    });
    assert.equal(changed.status, 200);
    assert.equal((await send('post', path, { plan: code, preview_id: preview.body.id })).status, 409);

    const revised = await send('post', `${path}/preview`, { plan: code });
    assert.equal(revised.status, 202);
    await execute();
    const queued = await send('post', path, { plan: code, preview_id: revised.body.id });
    assert.equal(queued.status, 202);
    assert.equal((await send('delete', `/plans/${code}`, {})).body.error.code, 'PLAN_IN_USE');
    const changedAgain = await send('put', `/plans/${code}`, { ...planBody(changed.body.plan), limits: { max_students: 20 } });
    assert.equal(changedAgain.status, 200);
    await execute();
    const tenant = (await get(`/tenants/${tenantId}`)).body;
    assert.equal(tenant.plan, code);
    assert.equal(tenant.plan_snapshot.version, 2);
    assert.deepEqual(tenant.plan_snapshot.limits, newPlan.limits);
    assert.deepEqual(tenant.plan_snapshot.backup, { schedule: 'daily', retention_days: 30 });
    assert.equal((await get(`/plans/${code}`)).body.tenants.outdated, 1);
  });

  test('solo el admin de plataforma escribe; cualquier sesión lee la lista', async () => {
    const tenantId = (await pool.query("SELECT id FROM tenants WHERE tenant_id = 'colegio-a'")).rows[0].id;
    viewerCookie = await session('tenant_admin', tenantId);
    const viewerPlans = await get('/plans', viewerCookie);
    assert.equal(viewerPlans.status, 200);
    assert.deepEqual(viewerPlans.body.items.find((plan) => plan.code === 'standard').tenants, { total: 1, outdated: 1 });
    assert.deepEqual(viewerPlans.body.items.find((plan) => plan.code === 'para-confirmar').tenants, { total: 0, outdated: 0 });
    assert.equal((await get('/plans/basic', viewerCookie)).status, 403);
    assert.equal((await send('post', '/plans', { ...newPlan, code: 'otro' }, viewerCookie)).status, 403);
    assert.equal((await send('put', '/plans/basic', {}, viewerCookie)).status, 403);
    assert.equal((await send('delete', '/plans/escuela-rural', {}, viewerCookie)).status, 403);
    assert.equal((await request(app).get('/api/v1/plans')).status, 401);
  });
});

// Outputs de base y AMIs mínimos (como tests/engines.test.js) para armar la entrada del motor.
async function engineConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'plans-test-'));
  engineDirectories.push(dir);
  await writeFile(
    join(dir, 'base.json'),
    JSON.stringify({
      project_name: 'attendance-platform',
      region: 'us-east-2',
      availability_zone: 'us-east-2a',
      vpc_id: 'vpc-00000000000000001',
      public_subnet_id: 'subnet-00000000000000001',
      private_subnet_id: 'subnet-00000000000000002',
      monitoring_security_group_id: 'sg-00000000000000001',
      ssm_endpoint_id: 'vpce-00000000000000001',
    }),
  );
  await writeFile(
    join(dir, 'ami.json'),
    JSON.stringify({
      region: 'us-east-2',
      image_version: '0.2.2',
      ami: { frontend: 'ami-0aec9c2e6b03643a3', backend: 'ami-0cba7c5e8e82efb49', db: 'ami-00c53587be2090056' },
    }),
  );
  return readConfig({
    DATABASE_URL: 'postgresql://unused',
    PLATFORM_DEPLOY_MODE: 'integration',
    IAC_STATE_BUCKET: 'attendance-state-test',
    IAC_BASE_OUTPUTS: join(dir, 'base.json'),
    IAC_AMI_IDS: join(dir, 'ami.json'),
  });
}
