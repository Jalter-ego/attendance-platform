import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { transaction } from '../db/pool.js';
import { appendEvent } from '../modules/operations/operations.service.js';
import { redact } from '../lib/redact.js';
import { CommandError } from './services/command-runner.js';
import { OperationCancelled, OperationError, LeaseLost } from './errors.js';
import { isLifecycle, isLocalBackup, persistLifecycle, runLifecycle } from './services/lifecycle.js';
import { runCreateOperation } from './handlers/create.handler.js';
import { scanBeforeCreate } from './services/security-scans.js';
import { createEngineAdapters } from './engines/index.js';
import { finishCreation, recoverLegacyTransition } from '../modules/deployments/deployments.service.js';
import {
  runBackupOperation,
  ScriptError,
} from '../modules/backups/backups.service.js';

// Handlers por tipo de operación: reciben { pool, config, operation, report, signal } y
// devuelven el resultado JSON que se guarda en operations.result.
const handlers = { backup: runBackupOperation, restore: runBackupOperation };

export async function recoverStale(pool, staleMs) {
  return transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE operations SET status = 'failed', stage = 'Worker interrumpido', error_message = 'El worker dejó de responder. Revisa la operación antes de reintentar.', worker_id = NULL, finished_at = now() WHERE status = 'running' AND heartbeat_at < now() - ($1 * interval '1 millisecond') RETURNING id, tenant_id, type, params",
      [staleMs],
    );
    for (const operation of result.rows) {
      if (isSnapshotCreate(operation)) await finishCreation(client, operation, 'failed');
      else if (operation.type === 'create') await persistLifecycle(client, operation, null, 'failed');
      else await recoverLegacyTransition(client, operation);
      await appendEvent(
        client,
        operation.id,
        'error',
        'El worker dejó de responder. La operación no se reejecutará automáticamente.',
      );
    }
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

const isSnapshotCreate = (operation) => operation.type === 'create' && Boolean(operation.params?.deployment);

// El diagnóstico y las simulaciones locales nunca llaman a AWS.
export async function runOnce(
  pool,
  { workerId = randomUUID(), signal, stepDelayMs = 350, heartbeatMs = 5000, config,
    adapters = createEngineAdapters(config), creationServices } = {},
) {
  const operation = await claimOperation(pool, workerId);
  if (!operation) return false;
  const lease = new AbortController();
  const jobSignal = signal
    ? AbortSignal.any([signal, lease.signal])
    : lease.signal;
  let heartbeat = Promise.resolve();
  let checkingLease = false;
  const timer = setInterval(() => {
    if (checkingLease) return;
    checkingLease = true;
    heartbeat = pool
      .query(
        "UPDATE operations SET heartbeat_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING cancel_requested",
        [operation.id, workerId],
      )
      .then((result) => {
        if (!result.rowCount) lease.abort(new LeaseLost());
        else if (result.rows[0].cancel_requested) lease.abort(new OperationCancelled());
      })
      .catch(() => lease.abort(new LeaseLost()))
      .finally(() => { checkingLease = false; });
  }, heartbeatMs);
  timer.unref();
  let status = 'succeeded';
  let errorMessage = null;
  let output = null;
  let lifecycle;
  // Registra un evento y, si se indica, la etapa/progreso. Corta si se pidió cancelar o si
  // este worker perdió la operación.
  const report = (message, { stage = null, progress = null, level = 'info' } = {}) =>
    transaction(pool, async (client) => {
      const result = await client.query(
        "UPDATE operations SET stage = COALESCE($3, stage), progress = COALESCE($4, progress), heartbeat_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING cancel_requested",
        [operation.id, workerId, stage === null ? null : redact(stage).slice(0, 100), progress],
      );
      if (!result.rowCount) throw new LeaseLost();
      if (result.rows[0].cancel_requested) throw new OperationCancelled();
      await appendEvent(client, operation.id, level, message, stage === null ? null : redact(stage).slice(0, 100));
    });
  try {
    if (operation.type === 'create' && config?.PLATFORM_SECURITY_SCANS &&
      (!isSnapshotCreate(operation) || config.PLATFORM_DEPLOY_MODE === 'integration')) {
      await scanBeforeCreate({ pool, config, operation, workerId, report, signal: jobSignal });
    }
    if (operation.type === 'diagnostic') {
      for (const [progress, stage, message] of steps) {
        jobSignal.throwIfAborted();
        await sleep(stepDelayMs, undefined, { signal: jobSignal });
        await report(message, { stage, progress });
      }
    } else if (isSnapshotCreate(operation)) {
      if (config?.PLATFORM_DEPLOY_MODE !== 'integration')
        throw new OperationError('IAC_MODE', 'Este trabajo fue registrado para infraestructura real. Reintenta desde el entorno de integración.');
      output = await runCreateOperation({ pool, config, operation, workerId, report, signal: jobSignal, adapters, creationServices });
    } else if (isLifecycle(operation.type) || isLocalBackup(operation.type, config)) {
      lifecycle = await runLifecycle({ pool, config, operation, report, stepDelayMs, signal: jobSignal, creationServices });
      if (lifecycle.failure) throw new OperationError('SIMULATED_FAILURE', lifecycle.failure);
      output = lifecycle.result ?? null;
    } else if (operation.type === 'destroy') {
      throw new OperationError('PREVIEW_REQUIRED', 'Genera una vista previa nueva y confirma la eliminación.');
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
    if (error instanceof LeaseLost || lease.signal.reason instanceof LeaseLost) return true;
    status = error instanceof OperationCancelled ||
      lease.signal.reason instanceof OperationCancelled ||
      (error instanceof CommandError && error.code === 'COMMAND_CANCELLED')
      ? 'cancelled' : 'failed';
    errorMessage =
      status !== 'failed'
        ? null
        : error instanceof ScriptError || error instanceof OperationError
          ? redact(error.message).slice(0, 500)
          : 'El worker se interrumpió. Revisa y reintenta la operación.';
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
  await transaction(pool, async (client) => {
    const result = await client.query(
      "UPDATE operations SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE $3 END, stage = CASE WHEN cancel_requested OR $3 = 'cancelled' THEN 'Cancelada' WHEN $3 = 'succeeded' THEN 'Completada' ELSE 'Fallida' END, error_message = CASE WHEN cancel_requested THEN NULL ELSE $4 END, result = CASE WHEN cancel_requested THEN NULL ELSE $5::jsonb END, progress = CASE WHEN NOT cancel_requested AND $3 = 'succeeded' THEN 100 ELSE progress END, finished_at = now(), worker_id = NULL WHERE id = $1 AND worker_id = $2 AND status = 'running' RETURNING status",
      [
        operation.id,
        workerId,
        status,
        errorMessage,
        output === null ? null : JSON.stringify(output),
      ],
    );
    if (result.rowCount) {
      if (isSnapshotCreate(operation)) await finishCreation(client, operation, result.rows[0].status);
      else if (isLifecycle(operation.type) || lifecycle) await persistLifecycle(client, operation, lifecycle, result.rows[0].status);
      else if (operation.type === 'destroy') await recoverLegacyTransition(client, operation);
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
    }
  });
  return true;
}
