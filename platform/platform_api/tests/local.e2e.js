import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.env.LOCAL_E2E_URL ?? 'http://127.0.0.1:4100');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Se requiere una API local.');
assert.ok(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD, 'Falta la cuenta de prueba.');
let cookie;
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(new URL('/api/v1' + path, base), {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (path === '/auth/login' && response.ok) cookie = response.headers.getSetCookie()[0].split(';')[0];
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${data?.error?.message ?? response.status}`);
  return data;
}

await request('/tenants', 'GET', undefined, 401);
await request('/auth/login', 'POST', { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
assert.equal((await request('/auth/me')).mode, 'local', 'Esta prueba solo puede operar en modo local.');

async function finished(id, status = 'succeeded') {
  for (let attempt = 0; attempt < 240; attempt++) {
    const operation = await request(`/operations/${id}`);
    if (!['queued', 'running'].includes(operation.status)) {
      assert.equal(operation.status, status, operation.error_message ?? operation.type);
      return operation;
    }
    await delay(100);
  }
  throw new Error(`El worker no terminó ${id}.`);
}

const data = {
  tenant_id: `p6-e2e-${randomUUID().slice(0, 8)}`, name: 'Prueba local P6',
  contact_email: 'p6@example.com', env: 'test', plan: 'basic', engine: 'cloudformation',
};
const { tenant, operation: initial } = await request('/tenants/provision', 'POST', { ...data, simulate_failure: true }, 202);
const tenantUrl = `/tenants/${tenant.id}`;
const operationPath = tenantUrl + '/operations';
const draft = await request('/tenants', 'POST', {
  ...data, tenant_id: `${data.tenant_id}-draft`, name: 'Borrador local P6', engine: 'pulumi',
}, 201);
const draftUrl = `/tenants/${draft.id}`;
await request(operationPath, 'POST', { type: 'diagnostic' }, 409);
await request('/tenants/provision', 'POST', { ...data, simulate_failure: true }, 409);
const failure = await finished(initial.id, 'failed');
assert.match(failure.error_message, /Fallo simulado/);
assert.equal((await request(tenantUrl)).status, 'failed');

const retried = await request(tenantUrl + '/retry', 'POST', { operation_id: initial.id }, 202);
await finished(retried.id);
assert.equal(retried.retry_of, initial.id);
const retryLogs = await request(`/operations/${retried.id}/logs?after=0`);
assert.ok(retryLogs.items.some((event) => /Reutilizando/.test(event.message)));
let detail = await request(tenantUrl);
const resources = detail.deployments[0].resources.map(({ id }) => id);
assert.equal(new Set(resources).size, 4);
assert.equal(detail.status, 'ready');
assert.equal(detail.deployments[0].outputs.urls.frontend, `/demo/${tenant.id}`);
assert.equal(detail.deployments[0].outputs.health.database, 'healthy');
assert.equal(detail.deployments[0].tool_versions.app, '1.0.0-local');
const list = await request(`/tenants?q=${data.tenant_id}&status=ready&limit=10`);
assert.equal(list.total, 1);
assert.equal(list.items[0].id, tenant.id);

async function run(body) {
  return finished((await request(operationPath, 'POST', body, 202)).id);
}
await finished((await request(tenantUrl + '/suspend', 'POST', {}, 202)).id);
detail = await request(tenantUrl);
assert.equal(detail.status, 'suspended');
assert.equal(detail.deployments[0].outputs.urls.frontend, null);
await run({ type: 'resume' });
detail = await request(tenantUrl);
assert.deepEqual(detail.deployments[0].resources.map(({ id }) => id), resources);

await run({ type: 'backup' });
const backup = (await request(tenantUrl + '/backups')).items[0];
await run({ type: 'restore', backup_id: backup.backup_id });
await run({ type: 'upgrade', scope: 'app', component: 'frontend', version: '2.0.0' });
assert.equal((await request(tenantUrl)).deployments[0].tool_versions.frontend, '2.0.0');
const planPreview = await run({ type: 'preview-plan', plan: 'advanced' });
assert.ok(planPreview.result.changes.some((change) => change.startsWith('Disco de datos:')));
assert.ok(planPreview.result.changes.some((change) => change.startsWith('Límite de estudiantes:')));
await request(operationPath, 'POST', { type: 'plan-change', plan: 'standard', preview_id: planPreview.id }, 409);
await run({ type: 'plan-change', plan: 'advanced', preview_id: planPreview.id });
assert.equal((await request(tenantUrl)).plan, 'advanced');
const stalePreview = await run({ type: 'preview-delete' });
await run({ type: 'upgrade', scope: 'infra', version: '0.2.2' });
await request(operationPath, 'POST', { type: 'delete', preview_id: stalePreview.id, confirm: true }, 409);
const preview = await run({ type: 'preview-delete' });
assert.ok(preview.result.changes.some((change) => change.includes('Disco de datos')));
assert.equal((await request(tenantUrl + '/delete-preview')).id, preview.id);
await request(operationPath, 'POST', { type: 'delete', preview_id: preview.id, confirm: false }, 400);

const account = { name: 'Admin de prueba', email: `${data.tenant_id}@example.com`, password: randomUUID() };
const admin = await request(tenantUrl + '/admins', 'POST', account, 201);
assert.equal(admin.role, 'tenant_admin');
assert.equal(admin.tenant_id, tenant.id);
assert.equal(admin.password_hash, undefined);
assert.deepEqual((await request(tenantUrl + '/admins')).items, [admin]);
const platformCookie = cookie;
const credentials = { email: account.email, password: account.password };
const { user } = await request('/auth/login', 'POST', credentials);
assert.equal(user.role, 'tenant_admin');
assert.equal((await request('/tenants')).total, 1);
assert.equal((await request(tenantUrl)).id, tenant.id);
await request(draftUrl, 'GET', undefined, 404);
await request(tenantUrl + '/admins', 'GET', undefined, 403);
await request(operationPath, 'POST', { type: 'diagnostic' }, 403);
await request('/audit', 'GET', undefined, 403);
await request('/plans/basic', 'PUT', {}, 403);
const tenantCookie = cookie;
cookie = platformCookie;
const accountUrl = `${tenantUrl}/admins/${admin.id}`;
const newPassword = randomUUID();
await request(accountUrl, 'PATCH', { password: newPassword });
cookie = tenantCookie;
await request('/auth/me', 'GET', undefined, 401);
await request('/auth/login', 'POST', credentials, 401);
await request('/auth/login', 'POST', { ...credentials, password: newPassword });
const changedTenantCookie = cookie;
cookie = platformCookie;
assert.equal((await request(accountUrl, 'PATCH', { active: false })).active, false);
cookie = changedTenantCookie;
await request('/auth/me', 'GET', undefined, 401);
cookie = platformCookie;
assert.equal((await request(accountUrl, 'PATCH', { active: true })).active, true);
await request(`${draftUrl}/admins/${admin.id}`, 'PATCH', { active: false }, 404);

const { items: catalog } = await request('/plans');
const { name, description, sizing, limits, backup: policy, version } = catalog.find((item) => item.code === 'basic');
const basic = { name, description, sizing, limits, backup: policy, version };
await request('/plans/basic', 'PUT', { ...basic, sizing: { ...sizing, db_disk_gb: 1 } }, 400);
const unchanged = await request('/plans/basic', 'PUT', basic);
assert.equal(unchanged.changed, false);
assert.equal(unchanged.plan.version, version);

await request('/auth/login', 'POST', { ...credentials, password: newPassword });
const deletingTenantCookie = cookie;
cookie = platformCookie;
await finished((await request(tenantUrl, 'DELETE', { preview_id: preview.id, confirm: true }, 202)).id);
assert.equal((await request(tenantUrl)).status, 'deleted');
assert.ok(!(await request(`/tenants?q=${data.tenant_id}&exclude_deleted=true`)).items.some((item) => item.id === tenant.id));
assert.equal((await request(tenantUrl + '/admins')).items[0].active, false);
cookie = deletingTenantCookie;
await request('/auth/me', 'GET', undefined, 401);
cookie = platformCookie;
const audit = await request(`/audit?q=${data.tenant_id}&env=test&status=succeeded&limit=40`);
assert.ok(audit.audit.some((entry) => entry.action === 'delete'));
assert.ok(audit.audit.some((entry) => entry.action === 'tenant-admin-create'));
assert.ok(audit.audit.some((entry) => entry.action === 'tenant-admin-reset'));
assert.ok(audit.audit.some((entry) => entry.action === 'tenant-admin-disable'));

const diagnostic = await request(draftUrl + '/operations', 'POST', { type: 'diagnostic' }, 202);
await request(`/operations/${diagnostic.id}/cancel`, 'POST', {});
await finished(diagnostic.id, 'cancelled');
const draftPreview = await finished((await request(draftUrl + '/delete-preview', 'POST', {}, 202)).id);
assert.equal(draftPreview.result.downtime, false);
await finished((await request(draftUrl, 'DELETE', { preview_id: draftPreview.id, confirm: true }, 202)).id);
const deletedDraft = await request(draftUrl);
assert.equal(deletedDraft.status, 'deleted');
assert.deepEqual(deletedDraft.deployments, []);
assert.ok((await request(`/audit?q=${draft.tenant_id}&limit=20`)).audit
  .some((entry) => entry.action === 'operation-cancel-request' && entry.operation_id === diagnostic.id));
await request('/auth/logout', 'POST', {}, 204);
await request('/auth/me', 'GET', undefined, 401);
console.log('Flujo PostgreSQL local: roles, revocación, bloqueo, cancelación, reintento, enlaces y versiones, ciclo de vida y borradores, catálogo y auditoría.');
