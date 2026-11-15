// Opt-in AWS acceptance: API/worker real, SSM and a PostgreSQL persistence marker.
// Run from the repository root with --allow-aws and --tenant-file or --engine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

const flags = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
assert.equal(flags['allow-aws'], true, 'Esta prueba crea/modifica AWS. Requiere --allow-aws.');
const apiRoot = process.env.PLATFORM_API_URL || 'http://127.0.0.1:4100/api/v1';
const login = await fetch(`${apiRoot}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(apiRoot).origin },
  body: JSON.stringify({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }) });
assert.equal(login.status, 200, 'No se pudo iniciar sesión en la plataforma local.');
const cookie = login.headers.getSetCookie().find(value => value.startsWith('platform_session=')).split(';')[0];
async function api(path, body) {
  const response = await fetch(`${apiRoot}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: new URL(apiRoot).origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error?.message || path}`);
  return data;
}
assert.equal((await api('/auth/me')).mode, 'integration', 'Solo admite una base en modo integration.');
let initial;
if (flags['tenant-file']) initial = JSON.parse(await readFile(resolve(flags['tenant-file']), 'utf8'));
else {
  assert.ok(['terraform', 'tofu', 'cloudformation', 'pulumi'].includes(flags.engine));
  const suffix = Date.now().toString(36);
  initial = await api('/tenants/provision', { tenant_id: `p6-check-${flags.engine}-${suffix}`, name: `Prueba P6 ${flags.engine}`,
    contact_email: 'operator@example.test', env: 'test', region: 'us-east-2', plan: 'basic', engine: flags.engine,
    timezone: 'America/La_Paz' });
}
const tenant = initial.tenant;
assert.match(tenant.tenant_id, /^p6-check-/);
assert.equal(tenant.env, 'test');
const evidence = { tenant: tenant.tenant_id, id: tenant.id, engine: tenant.engine, started: new Date().toISOString(), operations: [] };
const evidenceDir = resolve('.local/aws-evidence');
await mkdir(evidenceDir, { recursive: true });
if (flags.existing) {
  try {
    const previous = JSON.parse(await readFile(resolve(evidenceDir, `${tenant.tenant_id}.json`), 'utf8'));
    if (previous.id === tenant.id) {
      evidence.operations = previous.operations;
      if (previous.retry_reused_resources) evidence.retry_reused_resources = true;
    }
  } catch { /* First acceptance run of an existing tenant. */ }
}
async function save() { await writeFile(resolve(evidenceDir, `${tenant.tenant_id}.json`), JSON.stringify(evidence, null, 2)); }
async function action(type) {
  const current = await api(`/tenants/${tenant.id}`);
  const latest = current.operations[0];
  if (latest?.type === type && ['failed', 'cancelled'].includes(latest.status))
    return api(`/operations/${latest.id}/retry`, {});
  return api(`/tenants/${tenant.id}/operations`, { type });
}
async function wait(operation) {
  let last = '';
  const start = Date.now();
  for (;;) {
    const current = await api(`/operations/${operation.id}`);
    const state = `${current.status}: ${current.stage}`;
    if (state !== last) { console.log(`${tenant.engine} ${operation.type}: ${state}`); last = state; }
    if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      evidence.operations.push({ id: current.id, type: current.type, status: current.status, error: current.error_message, result: current.result });
      await save();
      if (current.status !== 'succeeded') {
        let after = '0', tail = [], page;
        do {
          page = await api(`/operations/${operation.id}/logs?after=${after}`);
          tail = [...tail, ...page.items].slice(-12);
          after = page.next_cursor;
        } while (page.has_more);
        console.log(JSON.stringify(tail.map(event => ({ level: event.level, message: event.message }))));
        throw new Error(current.error_message || 'La operación no terminó correctamente.');
      }
      return current;
    }
    assert.ok(Date.now() - start < 75 * 60 * 1000, 'La operación excedió 75 minutos. Revisar el worker.');
    await sleep(5000);
  }
}
let failedResources;
if (flags.existing) {
  const current = await api(`/tenants/${tenant.id}`);
  if (current.status === 'suspended') await wait(await action('resume'));
  else assert.equal(current.status, 'ready', 'El tenant existente debe estar disponible o suspendido.');
} else if (flags.retry) {
  const previous = await api(`/operations/${initial.operation.id}`);
  assert.ok(['failed', 'cancelled'].includes(previous.status), 'La creación original debe haber fallado para comprobar el reintento.');
  const failedDetail = await api(`/tenants/${tenant.id}`);
  failedResources = failedDetail.deployments[0]?.outputs?.instance_ids;
  assert.ok(failedResources, 'La prueba exige recursos parciales registrados antes del fallo.');
  evidence.operations.push({ id: previous.id, type: previous.type, status: previous.status, error: previous.error_message });
  await wait(await api(`/operations/${previous.id}/retry`, {}));
} else await wait(initial.operation);
let detail = await api(`/tenants/${tenant.id}`);
const deployed = detail.deployments[0];
evidence.resources = deployed.resources;
evidence.outputs = deployed.outputs;
evidence.versions = deployed.tool_versions;
assert.equal(new Set(Object.values(deployed.outputs.instance_ids)).size, 3);
if (failedResources) {
  assert.deepEqual(deployed.outputs.instance_ids, failedResources, 'El reintento debe reutilizar las mismas EC2.');
  evidence.retry_reused_resources = true;
}
await save();
if (flags['create-only']) {
  console.log(`PASS ${tenant.engine}: creación y salud comprobadas.`);
  process.exit(0);
}
const ids = deployed.outputs.instance_ids;
const volume = deployed.outputs.db_volume_id;
assert.ok(volume);
const marker = randomUUID();
const ssm = new SSMClient({ region: tenant.region });
async function databaseMarker(write) {
  const sql = write
    ? `CREATE TABLE IF NOT EXISTS public.p6_validation (marker text PRIMARY KEY); INSERT INTO public.p6_validation VALUES ('${marker}') ON CONFLICT DO NOTHING;`
    : `SELECT marker FROM public.p6_validation WHERE marker='${marker}';`;
  const commands = ['set -eu', '. /etc/attendance/backup.env',
    `sudo -u postgres psql -v ON_ERROR_STOP=1 -At -d "$DB_NAME" -c "${sql}"`];
  let command;
  for (let attempt = 0; attempt < 24; attempt++) {
    try { command = await ssm.send(new SendCommandCommand({ DocumentName: 'AWS-RunShellScript', InstanceIds: [ids.db],
      Parameters: { commands }, TimeoutSeconds: 120, Comment: 'P6 acceptance marker: data survives suspension' })); break; }
    catch (error) { if (error.name !== 'InvalidInstanceId' || attempt === 23) throw error; await sleep(5000); }
  }
  for (let attempt = 0; attempt < 36; attempt++) {
    await sleep(5000);
    let result;
    try { result = await ssm.send(new GetCommandInvocationCommand({ CommandId: command.Command.CommandId, InstanceId: ids.db })); }
    catch (error) { if (error.name === 'InvocationDoesNotExist') continue; throw error; }
    if (['Pending', 'InProgress', 'Delayed'].includes(result.Status)) continue;
    assert.equal(result.Status, 'Success', `Falló el marcador PostgreSQL: ${result.StandardErrorContent}`);
    if (!write) assert.equal(result.StandardOutputContent.trim(), marker, 'No se conservó el dato PostgreSQL.');
    return;
  }
  throw new Error('SSM no confirmó la comprobación de datos.');
}
try {
  evidence.marker = marker;
  await save();
  await databaseMarker(true);
  await wait(await action('suspend'));
  await wait(await action('resume'));
  detail = await api(`/tenants/${tenant.id}`);
  assert.deepEqual(detail.deployments[0].outputs.instance_ids, ids, 'Cambió una EC2 al reanudar.');
  assert.equal(detail.deployments[0].outputs.db_volume_id, volume, 'Cambió el disco de datos.');
  await databaseMarker(false);
  evidence.data_preserved = true;
  evidence.resumed_outputs = detail.deployments[0].outputs;
  if (!flags['keep-running']) await wait(await action('suspend'));
  evidence.final_status = (await api(`/tenants/${tenant.id}`)).status;
  evidence.finished = new Date().toISOString();
  await save();
  console.log(`PASS ${tenant.engine}: tres EC2, salud y datos conservados. Estado final: ${evidence.final_status}.`);
} finally { ssm.destroy(); await save(); }
