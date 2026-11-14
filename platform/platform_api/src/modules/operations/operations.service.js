import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { redact } from '../../lib/redact.js';
import { getTenant, uuid } from '../tenants/tenants.service.js';
import { backupIdInput } from '../backups/backups.service.js';

export async function appendEvent(client, id, level, message) {
  await client.query(
    'INSERT INTO operation_events(operation_id, level, message) VALUES ($1,$2,$3)',
    [id, level, redact(message)],
  );
}

const operationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagnostic') }).strict(),
  z.object({ type: z.literal('backup') }).strict(),
  z.object({ type: z.literal('restore'), backup_id: backupIdInput }).strict(),
]);

export async function enqueue(pool, user, tenantId, input, retryOf = null) {
  await getTenant(pool, user, tenantId);
  const { type, ...params } = operationInput.parse(input);
  return transaction(pool, async (client) => {
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
    return result.rows[0];
  });
}

export async function retryOperation(pool, user, id) {
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
    { type: previous.type, ...previous.params },
    previous.id,
  );
}
