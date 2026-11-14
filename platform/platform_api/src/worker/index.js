import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { recoverStale, runOnce } from './queue.js';
import { databaseErrorMessage } from '../db/diagnostics.js';

const config = readConfig();
const pool = createPool(config);
const workerId = randomUUID();
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log('Worker iniciado. Esperando operaciones.');
try {
  while (!controller.signal.aborted) {
    try {
      await recoverStale(pool, config.WORKER_STALE_MS);
      const processed = await runOnce(pool, {
        workerId,
        signal: controller.signal,
        config,
      });
      if (processed) continue;
    } catch (error) {
      console.error(databaseErrorMessage(error));
    }
    await sleep(config.WORKER_POLL_MS, undefined, {
      signal: controller.signal,
    }).catch(() => {});
  }
} finally {
  await pool.end();
  console.log('Worker detenido.');
}
