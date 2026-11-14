import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { redact } from '../../lib/redact.js';
import { getTenant, uuid } from '../tenants/tenants.service.js';
import { backupIdInput } from '../backups/backups.service.js';
import { buildSnapshot, validateSnapshot } from '../deployments/deployment-config.js';
import { finishCreation, infrastructureStates } from '../deployments/deployments.service.js';
import { getEngineAdapter, createEngineAdapters } from '../../worker/engines/index.js';
import { OperationError } from '../../worker/errors.js';
import { assertCanEnqueue } from '../provisioning/provisioning.service.js';

export async function appendEvent(client, id, level, message) {
  await client.query(
    'INSERT INTO operation_events(operation_id, level, message) VALUES ($1,$2,$3)',
    [id, level, redact(message)],
  );
}

const operationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostic') }).strict(),
  z.object({ type: z.literal('create') }).strict(),
  z.object({ type: z.literal('backup') }).strict(),
  z.object({ type: z.literal('restore'), backup_id: backupIdInput }).strict(),
  // P2: destroy exige confirm = tenant_id (RF-18).
  z.object({ type: z.literal('suspend') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('destroy'), confirm: z.string().max(40) }).strict(),
]);

export async function enqueue(pool, user, tenantId, input, retryOf = null, { config, adapters = createEngineAdapters(config) } = {}) {
  const tenant = await getTenant(pool, user, tenantId);
  const { type, ...params } = operationInput.parse(input);
  const infrastructure = Object.hasOwn(infrastructureStates, type);
  if (infrastructure) {
    try { getEngineAdapter(tenant.engine, adapters); }
    catch (error) { throw new HttpError(503, 'ENGINE_NOT_AVAILABLE', error.message); }
  }
  return transaction(pool, async (client) => {
    if (infrastructure) {
      const current = (await client.query('SELECT * FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])).rows[0];
      const active = await client.query("SELECT id FROM operations WHERE tenant_id=$1 AND status IN ('queued','running')", [tenantId]);
      if (active.rowCount) throw new HttpError(409, 'TENANT_BUSY', 'Esta institución ya tiene una operación pendiente.');
      if (!current || (type === 'create' && !['draft', 'failed'].includes(current.status)))
        throw new HttpError(409, 'TENANT_ALREADY_DEPLOYED', 'Esta institución ya está desplegada o tiene un cambio en curso.');
      assertCanEnqueue(current, type, params);
      // También una nueva solicitud tras un fallo reutiliza el primer snapshot.
      const previous = await client.query("SELECT params FROM operations WHERE tenant_id=$1 AND params ? 'deployment' ORDER BY created_at, id LIMIT 1", [tenantId]);
      try {
        if (previous.rowCount) params.deployment = validateSnapshot(previous.rows[0].params.deployment, current);
        else {
          const plan = (await client.query('SELECT * FROM plans WHERE code = $1', [current.plan])).rows[0];
          if (!plan) throw new HttpError(409, 'PLAN_NOT_FOUND', 'El plan de esta institución ya no está disponible.');
          params.deployment = await buildSnapshot(current, plan, config);
        }
      } catch (error) {
        if (error instanceof OperationError) throw new HttpError(503, error.code, error.message);
        throw error;
      }
    }
    const result = await client.query(
      'INSERT INTO operations(id, tenant_id, type, initiated_by, retry_of, params) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(), tenantId, type, user.id, retryOf, params],
    );
    await appendEvent(
      client,
      result.rows[0].id,
      'info',
      'Operación en cola. Esperando al worker.',
    );
    if (infrastructure) await client.query('UPDATE tenants SET status=$2, updated_at=now() WHERE id=$1', [tenantId, infrastructureStates[type].running]);
    return result.rows[0];
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
      "UPDATE operations SET cancel_requested = true, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, stage = CASE WHEN status = 'queued' THEN 'Cancelada' ELSE stage END, finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END WHERE id = $1 AND status IN ('queued','running') RETURNING *",
      [id],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        'OPERATION_FINISHED',
        'La operación ya terminó.',
      );
    await appendEvent(
      client,
      id,
      'warning',
      'Se solicitó cancelar la operación.',
    );
    if (result.rows[0].status === 'cancelled') await finishCreation(client, result.rows[0], 'cancelled');
    return result.rows[0];
  });
}

export async function retryOperation(pool, user, id, options) {
  const previous = await getOperation(pool, user, id);
  if (!['failed', 'cancelled'].includes(previous.status))
    throw new HttpError(
      409,
      'NOT_RETRYABLE',
      'Solo se pueden reintentar operaciones fallidas o canceladas.',
    );
  return enqueue(
    pool,
    user,
    previous.tenant_id,
    Object.hasOwn(infrastructureStates, previous.type)
      ? { type: previous.type, ...(previous.type === 'destroy' ? { confirm: previous.params.confirm } : {}) }
      : { type: previous.type, ...previous.params },
    previous.id,
    options,
  );
}
