import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { redact } from '../../lib/redact.js';
import { getTenant, registerTenant, tenantInput, uuid } from '../tenants/tenants.service.js';
import { backupIdInput } from '../backups/backups.service.js';
import { supportsRealLifecycle } from '../../engines/lifecycle-capabilities.js';
import { planCode } from '../plans/plans.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { buildSnapshot, validateSnapshot } from '../deployments/deployment-config.js';
import { createEngineAdapters, getEngineAdapter } from '../../worker/engines/index.js';
import { OperationError } from '../../worker/errors.js';

export async function appendEvent(client, id, level, message, stage = null) {
  await client.query(
    'INSERT INTO operation_events(operation_id, level, message, stage) VALUES ($1,$2,$3,$4)',
    [id, level, redact(message).slice(0, 4000), stage],
  );
}

const operationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostic') }).strict(),
  z.object({ type: z.literal('backup') }).strict(),
  z.object({ type: z.literal('restore'), backup_id: z.union([backupIdInput, uuid]) }).strict(),
  z.object({ type: z.literal('create') }).strict(),
  z.object({ type: z.literal('suspend') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('upgrade'), scope: z.enum(['app', 'infra']), version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), component: z.enum(['backend', 'frontend']).optional() }).strict(),
  z.object({ type: z.literal('preview-plan'), plan: planCode }).strict(),
  z.object({ type: z.literal('preview-delete') }).strict(),
  z.object({ type: z.literal('plan-change'), plan: planCode, preview_id: uuid }).strict(),
  z.object({ type: z.literal('delete'), preview_id: uuid, confirm: z.literal(true) }).strict(),
  z.object({ type: z.literal('destroy'), preview_id: uuid.optional(), confirm: z.string().max(40) }).strict(),
]);

const validStates = {
  create: ['draft', 'failed'],
  suspend: ['ready'],
  resume: ['suspended'],
  upgrade: ['ready'],
  'plan-change': ['ready'],
  'preview-plan': ['ready'],
  delete: ['draft', 'ready', 'suspended', 'failed'],
  'preview-delete': ['draft', 'ready', 'suspended', 'failed'],
};

function verifyMode(config, tenant, type, params) {
  if (config.PLATFORM_DEPLOY_MODE !== 'integration' || !validStates[type]) return;
  if (tenant.status === 'draft' && ['delete', 'preview-delete'].includes(type)) return;
  if (!supportsRealLifecycle(tenant.engine, type))
    throw new HttpError(422, 'ENGINE_UNSUPPORTED', 'Esta operación aún no está disponible en integración para el motor elegido.');
  if (type === 'upgrade' && params.scope === 'app' && !/^[a-f0-9]{12}$/.test(params.version))
    throw new HttpError(400, 'INVALID_RELEASE', 'Ingresa los 12 caracteres hexadecimales de una versión publicada.');
}

async function insertOperation(client, user, tenant, type, params, retryOf = null) {
  const result = await client.query(
    'INSERT INTO operations(id, tenant_id, type, initiated_by, retry_of, params) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [randomUUID(), tenant.id, type, user.id, retryOf, params],
  );
  await appendEvent(client, result.rows[0].id, 'info', 'Operación en cola. Esperando al worker.', 'En cola');
  return result.rows[0];
}

async function findPreview(client, user, tenantId, type, id = null) {
  const { rows } = await client.query(
    `SELECT o.* FROM operations o WHERE ($1::uuid IS NULL OR o.id=$1) AND o.tenant_id=$2
       AND o.type=$3 AND o.initiated_by=$4 AND o.status='succeeded'
       AND o.finished_at > now() - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM operations newer WHERE newer.tenant_id=o.tenant_id
        AND newer.created_at >= o.finished_at AND newer.id<>o.id
        AND newer.type NOT IN ('diagnostic','backup','preview-delete','preview-plan'))
       ORDER BY o.finished_at DESC,id LIMIT 1`,
    [id, tenantId, type, user.id],
  );
  return rows[0];
}

function stalePreview() {
  return new HttpError(409, 'PREVIEW_REQUIRED', 'Genera una vista previa nueva y confirma el cambio.');
}

export async function deletePreview(pool, user, tenantId) {
  const tenant = await getTenant(pool, user, tenantId);
  const preview = await findPreview(pool, user, tenant.id, 'preview-delete');
  if (!preview) throw stalePreview();
  return preview;
}

async function requirePreview(client, user, tenant, type, params) {
  const expected = type === 'delete' ? 'preview-delete' : 'preview-plan';
  const preview = params.preview_id && await findPreview(client, user, tenant.id, expected, params.preview_id);
  if (!preview || (type === 'plan-change' && preview.params.plan !== params.plan))
    throw stalePreview();
  return preview;
}

async function lockPlan(client, code, appliedSnapshot) {
  const { rows: [catalog] } = await client.query(
    `SELECT snapshot, snapshot <> $2::jsonb AS differs FROM (
      SELECT jsonb_build_object(
        'code',code,'name',name,'version',version,'sizing',sizing,'limits',limits,'backup',backup
      ) AS snapshot FROM plans WHERE code=$1 FOR SHARE
    ) locked_plan`,
    [code, appliedSnapshot],
  );
  return catalog;
}

async function preparePlanChange(client, tenant, params, preview) {
  const catalog = await lockPlan(client, params.plan, tenant.plan_snapshot);
  if (!catalog) throw new HttpError(404, 'PLAN_NOT_FOUND', 'No se encontró el plan.');
  if (preview) {
    const { rows: [{ unchanged }] } = await client.query('SELECT $1::jsonb = $2::jsonb AS unchanged',
      [catalog.snapshot, preview.params.plan_snapshot ?? null]);
    if (!unchanged) throw stalePreview();
  }
  if (!catalog.differs) throw new HttpError(409, 'PLAN_UNCHANGED', 'La institución ya usa esa configuración del plan.');
  return catalog.snapshot;
}

async function deploymentContext(client, config, tenant, type, params, retryOf, adapters) {
  if (config.PLATFORM_DEPLOY_MODE !== 'integration' || !validStates[type]) return params;
  if (tenant.status === 'draft' && ['delete', 'preview-delete'].includes(type)) return params;
  if (type === 'create') {
    try { getEngineAdapter(tenant.engine, adapters); }
    catch (error) { throw new HttpError(503, 'ENGINE_NOT_AVAILABLE', error.message); }
  }
  const { rows: [initial] } = await client.query(
    `SELECT params->'deployment' AS deployment FROM operations WHERE tenant_id=$1
       AND type='create' AND params ? 'deployment' ORDER BY created_at,id LIMIT 1`,
    [tenant.id],
  );
  try {
    if (initial) return { ...params, deployment: validateSnapshot(initial.deployment, tenant) };
    // Un tenant anterior al snapshot de PR26 conserva el mecanismo de estado ya fijado.
    if (type !== 'create' || retryOf) return params;
    return { ...params, deployment: await buildSnapshot(tenant, tenant.plan_snapshot, config) };
  } catch (error) {
    if (error instanceof OperationError) throw new HttpError(503, error.code, error.message);
    throw error;
  }
}

async function queueForTenant(client, config, user, tenant, type, params, retryOf = null, adapters) {
  const busy = await client.query("SELECT 1 FROM operations WHERE tenant_id=$1 AND status IN ('queued','running') LIMIT 1", [tenant.id]);
  if (busy.rowCount)
    throw new HttpError(409, 'TENANT_BUSY', 'Esta institución ya tiene una operación pendiente.');
  if (validStates[type] && !validStates[type].includes(tenant.status))
    throw new HttpError(409, 'INVALID_TENANT_STATUS', 'Esta operación no corresponde al estado de la institución.');
  if (config.PLATFORM_DEPLOY_MODE === 'local' && ['backup','restore'].includes(type) && tenant.status !== 'ready')
    throw new HttpError(409, 'TENANT_NOT_READY', 'La institución debe estar activa para respaldar o restaurar.');
  if (config.PLATFORM_DEPLOY_MODE === 'integration' && type === 'restore' && !backupIdInput.safeParse(params.backup_id).success)
    throw new HttpError(400, 'INVALID_BACKUP', 'Selecciona un respaldo creado en la infraestructura real.');
  if (type === 'create' && !retryOf && tenant.status === 'failed')
    throw new HttpError(409, 'RETRY_REQUIRED', 'Abre la última creación fallida y usa Reintentar para continuar.');
  verifyMode(config, tenant, type, params);
  const preview = ['plan-change','delete'].includes(type) && !retryOf
    ? await requirePreview(client, user, tenant, type, params)
    : null;
  if (['delete', 'preview-delete'].includes(type) && tenant.status === 'draft') {
    const attemptedCreate = await client.query(
      "SELECT 1 FROM operations WHERE tenant_id=$1 AND type='create' AND started_at IS NOT NULL LIMIT 1",
      [tenant.id],
    );
    if (attemptedCreate.rowCount)
      throw new HttpError(409, 'RETRY_REQUIRED', 'Abre la creación anterior y reintenta para comprobar el estado de sus recursos.');
  }
  if (['plan-change','preview-plan'].includes(type) && !retryOf) {
    const plan = await preparePlanChange(client, tenant, params, preview);
    params = { ...params, plan_snapshot: plan };
  }
  if (type === 'plan-change' && retryOf) {
    const catalog = params.plan_snapshot && await lockPlan(client, params.plan, tenant.plan_snapshot);
    if (!catalog) throw stalePreview();
  }
  const context = await deploymentContext(client, config, tenant, type, params, retryOf, adapters);
  const operation = await insertOperation(client, user, tenant, type, context, retryOf);
  // Conserva el estado provisional de PR26 hasta que finalice la operación dueña.
  if (type === 'create' && context.deployment)
    await client.query("UPDATE tenants SET status='provisioning',updated_at=now() WHERE id=$1", [tenant.id]);
  return operation;
}

export function enqueue(pool, config, user, tenantId, input, { adapters = createEngineAdapters(config) } = {}) {
  const { type, ...params } = operationInput.parse(input);
  return transaction(pool, async (client) => {
    const tenant = await getTenant(client, user, tenantId, { lock: true });
    if (type === 'destroy') {
      if (params.confirm !== tenant.tenant_id)
        throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Confirma el identificador de la institución para eliminarla.');
      return queueForTenant(client, config, user, tenant, 'delete', { preview_id: params.preview_id ?? null, confirm: true }, null, adapters);
    }
    return queueForTenant(client, config, user, tenant, type, params, null, adapters);
  });
}

export function provisionTenant(pool, config, user, input, { adapters = createEngineAdapters(config) } = {}) {
  const { simulate_failure = false, ...data } = input ?? {};
  z.boolean().parse(simulate_failure);
  const tenantData = tenantInput.parse(data);
  return transaction(pool, async (client) => {
    const tenant = await registerTenant(client, tenantData);
    const params = config.PLATFORM_DEPLOY_MODE === 'local' ? { simulate_failure } : {};
    const operation = await queueForTenant(client, config, user, tenant, 'create', params, null, adapters);
    return { tenant: operation.params.deployment ? { ...tenant, status: 'provisioning' } : tenant, operation };
  });
}

export async function getOperation(pool, user, id) {
  uuid.parse(id);
  const result = await pool.query(
    'SELECT o.* FROM operations o JOIN tenants t ON t.id = o.tenant_id WHERE o.id = $1 AND ($2::uuid IS NULL OR t.id = $2)',
    [id, user.role === 'platform_admin' ? null : user.tenant_id],
  );
  if (!result.rowCount)
    throw new HttpError(404, 'NOT_FOUND', 'No se encontró la operación.');
  return result.rows[0];
}

export async function operationLogs(pool, user, id, query) {
  await getOperation(pool, user, id);
  const { after } = z
    .object({
      after: z
        .string()
        .regex(/^\d{1,18}$/)
        .default('0'),
    })
    .parse(query);
  const result = await pool.query(
    'SELECT * FROM operation_events WHERE operation_id = $1 AND id > $2::bigint ORDER BY id LIMIT 201',
    [id, after],
  );
  const items = result.rows.slice(0, 200);
  return {
    items,
    next_cursor: items.at(-1)?.id ?? after,
    has_more: result.rows.length > 200,
  };
}

export async function cancelOperation(pool, user, id) {
  await getOperation(pool, user, id);
  return transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE operations SET cancel_requested = true, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, stage = CASE WHEN status = 'queued' THEN 'Cancelada' ELSE stage END, finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END WHERE id = $1 AND status IN ('queued','running') AND NOT cancel_requested RETURNING *",
      [id],
    );
    if (!result.rowCount) {
      const operation = await getOperation(client, user, id);
      if (operation.cancel_requested) return operation;
      throw new HttpError(
        409,
        'OPERATION_FINISHED',
        'La operación ya terminó.',
      );
    }
    await appendEvent(
      client,
      id,
      'warning',
      'Se solicitó cancelar la operación.',
    );
    await recordAudit(client, user, {
      tenantId: result.rows[0].tenant_id, operationId: id, action: 'operation-cancel-request',
    });
    if (result.rows[0].type === 'create' && result.rows[0].status === 'cancelled')
      await client.query("UPDATE tenants SET status='failed',updated_at=now() WHERE id=$1 AND status='provisioning'", [result.rows[0].tenant_id]);
    return result.rows[0];
  });
}

export function retryOperation(pool, config, user, id, tenantId = null, { adapters = createEngineAdapters(config) } = {}) {
  return transaction(pool, async (client) => {
    const previous = await getOperation(client, user, id);
    if (tenantId !== null && previous.tenant_id !== uuid.parse(tenantId))
      throw new HttpError(404, 'NOT_FOUND', 'No se encontró la operación en esta institución.');
    const tenant = await getTenant(client, user, previous.tenant_id, { lock: true });
    if (previous.type === 'destroy')
      throw new HttpError(409, 'PREVIEW_REQUIRED', 'Genera una vista previa nueva para eliminar esta institución.');
    if (!['failed', 'cancelled'].includes(previous.status))
      throw new HttpError(409, 'NOT_RETRYABLE', 'Solo se pueden reintentar operaciones fallidas o canceladas.');
    if (validStates[previous.type] && !previous.type.startsWith('preview-')) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM operations WHERE tenant_id=$1 AND id<>$2 AND created_at >= $3
           AND type NOT IN ('diagnostic','backup','preview-delete','preview-plan') LIMIT 1`,
        [tenant.id, previous.id, previous.created_at],
      );
      if (rowCount)
        throw new HttpError(409, 'STALE_RETRY', 'Existe una operación más reciente. Abre su historial para continuar.');
    }
    return queueForTenant(client, config, user, tenant, previous.type, previous.params, previous.id, adapters);
  });
}
