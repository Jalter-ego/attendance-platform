import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { transaction } from '../db/pool.js';
import { appendEvent } from '../modules/operations/operations.service.js';
import {
  runBackupOperation,
  ScriptError,
} from '../modules/backups/backups.service.js';
import { runInfraOperation } from '../modules/provisioning/provisioning.service.js';
import { OperationError } from '../lib/operation-error.js';

// Handlers por tipo de operación: reciben { pool, config, operation, report, signal } y
// devuelven el resultado JSON que se guarda en operations.result.
const handlers = {
  backup: runBackupOperation,
  restore: runBackupOperation,
  // P2: motores IaC (src/engines) a través de provisioning.service.js.
  create: runInfraOperation,
  suspend: runInfraOperation,
  resume: runInfraOperation,
  destroy: runInfraOperation,
};

class Cancelled extends Error {}
class LeaseLost extends Error {}

export async function recoverStale(pool, staleMs) {
  return transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE operations SET status = 'failed', stage = 'Worker interrumpido', error_message = 'El worker dejó de responder. Revisa la operación antes de reintentar.', worker_id = NULL, finished_at = now() WHERE status = 'running' AND heartbeat_at < now() - ($1 * interval '1 millisecond') RETURNING id",
      [staleMs],
    );
    for (const operation of result.rows)
      await appendEvent(
        client,
        operation.id,
        'error',
        'El worker dejó de responder. La operación no se reejecutará automáticamente.',
      );
    return result.rowCount;
  });
}

export async function claimOperation(pool, workerId) {
  return transaction(pool, async (client) => {
    const next = await client.query(
      "SELECT id FROM operations WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!next.rowCount) return null;
    const result = await client.query(
      "UPDATE operations SET status = 'running', stage = 'Iniciando', started_at = now(), heartbeat_at = now(), worker_id = $2 WHERE id = $1 RETURNING *",
      [next.rows[0].id, workerId],
    );
    await appendEvent(
      client,
      result.rows[0].id,
      'info',
      'El worker inició la operación.',
    );
    return result.rows[0];
  });
}

const steps = [
  [20, 'Revisando institución', 'Registro de institución leído correctamente.'],
  [
    50,
    'Validando configuración',
    'Identificador, entorno y motor disponibles.',
  ],
  [
    80,
    'Comprobando cola',
    'Comunicación entre API, PostgreSQL y worker correcta.',
  ],
  [
    100,
    'Prueba completada',
    'Diagnóstico completado. No se crearon recursos en AWS.',
  ],
];

// Los handlers de los motores (P2) están en `handlers`. El diagnóstico nunca llama a AWS.
export async function runOnce(
  pool,
  { workerId = randomUUID(), signal, stepDelayMs = 350, config } = {},
) {
  const operation = await claimOperation(pool, workerId);
  if (!operation) return false;
  const lease = new AbortController();
  const jobSignal = signal
    ? AbortSignal.any([signal, lease.signal])
    : lease.signal;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = pool
      .query(
        "UPDATE operations SET heartbeat_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running'",
        [operation.id, workerId],
      )
      .then((result) => {
        if (!result.rowCount) lease.abort();
      })
      .catch(() => lease.abort());
  }, 5000);
  timer.unref();
  let status = 'succeeded';
  let errorMessage = null;
  let output = null;
  // Registra un evento y, si se indica, la etapa/progreso. Corta si se pidió cancelar o si
  // este worker perdió la operación.
  const report = (message, { stage = null, progress = null, level = 'info' } = {}) =>
    transaction(pool, async (client) => {
      const result = await client.query(
        "UPDATE operations SET stage = COALESCE($3, stage), progress = COALESCE($4, progress), heartbeat_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING cancel_requested",
        [operation.id, workerId, stage, progress],
      );
      if (!result.rowCount) throw new LeaseLost();
      if (result.rows[0].cancel_requested) throw new Cancelled();
      await appendEvent(client, operation.id, level, message);
    });
  try {
    if (operation.type === 'diagnostic') {
      for (const [progress, stage, message] of steps) {
        jobSignal.throwIfAborted();
        await sleep(stepDelayMs, undefined, { signal: jobSignal });
        await report(message, { stage, progress });
      }
    } else if (handlers[operation.type]) {
      output = await handlers[operation.type]({
        pool,
        config,
        operation,
        report,
        signal: jobSignal,
      });
    } else throw new Error('Unsupported handler');
  } catch (error) {
    if (error instanceof LeaseLost || lease.signal.aborted) return true;
    status = error instanceof Cancelled ? 'cancelled' : 'failed';
    errorMessage =
      status !== 'failed'
        ? null
        : error instanceof ScriptError || error instanceof OperationError
          ? error.message.slice(0, 500)
          : 'El worker se interrumpió. Revisa y reintenta la operación.';
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
  await transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE operations SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE $3 END, stage = CASE WHEN cancel_requested OR $3 = 'cancelled' THEN 'Cancelada' WHEN $3 = 'succeeded' THEN 'Completada' ELSE 'Fallida' END, error_message = CASE WHEN cancel_requested THEN NULL ELSE $4 END, result = $5::jsonb, finished_at = now(), worker_id = NULL WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING status",
      [
        operation.id,
        workerId,
        status,
        errorMessage,
        output === null ? null : JSON.stringify(output),
      ],
    );
    if (result.rowCount)
      await appendEvent(
        client,
        operation.id,
        result.rows[0].status === 'failed' ? 'error' : 'info',
        result.rows[0].status === 'succeeded'
          ? 'Operación finalizada correctamente.'
          : result.rows[0].status === 'cancelled'
            ? 'Operación cancelada.'
            : errorMessage,
      );
  });
  return true;
}
