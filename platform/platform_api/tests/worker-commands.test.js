import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { runOnce } from '../src/worker/queue.js';

const config = {
  ...readConfig({ DATABASE_URL: 'postgresql://unused', PLATFORM_DEPLOY_MODE: 'integration' }),
  BACKUP_SCRIPT: fileURLToPath(new URL('./fixtures/fake-backup.sh', import.meta.url)),
};

// Doble de la conexión: verifica el flujo del worker sin tocar PostgreSQL/AWS.
function operationPool(onHeartbeat = () => {}) {
  const operation = { id: 'op-1', tenant_id: 'tenant-1', type: 'backup', status: 'queued', cancel_requested: false };
  const state = { operation, events: [], owns: true, finalized: false };
  const rows = (data) => ({ rows: data, rowCount: data.length });
  const pool = {
    ...state,
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql, values = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows([]);
      if (sql.startsWith('SELECT id FROM operations')) return rows(operation.status === 'queued' ? [{ id: operation.id }] : []);
      if (sql.includes("SET status = 'running'")) { operation.status = 'running'; return rows([operation]); }
      if (sql.startsWith('INSERT INTO operation_events')) { pool.events.push(values[2]); return rows([]); }
      if (sql.startsWith('SELECT * FROM tenants')) return rows([{ tenant_id: 'demo', env: 'test', region: 'us-east-2' }]);
      if (sql.startsWith('UPDATE operations SET heartbeat_at')) {
        onHeartbeat(pool);
        return rows(pool.owns ? [{ cancel_requested: operation.cancel_requested }] : []);
      }
      if (sql.startsWith('UPDATE operations SET stage')) return rows(pool.owns ? [{ cancel_requested: operation.cancel_requested }] : []);
      if (sql.startsWith('UPDATE operations SET status = CASE')) {
        pool.finalized = true;
        operation.status = operation.cancel_requested ? 'cancelled' : values[2];
        operation.error_message = values[3];
        return rows(pool.owns ? [{ status: operation.status }] : []);
      }
      throw new Error('Consulta no prevista en la prueba');
    },
  };
  return pool;
}

test('Cancelar llega al proceso aunque no escriba logs y finaliza como cancelada', async () => {
  process.env.FAKE_MODE = 'silent';
  const pool = operationPool((pool) => { pool.operation.cancel_requested = true; });
  try {
    const started = Date.now();
    assert.equal(await runOnce(pool, { config, heartbeatMs: 25 }), true);
    assert.equal(pool.operation.status, 'cancelled');
    assert.equal(pool.finalized, true);
    assert.ok(Date.now() - started < 5000);
  } finally { delete process.env.FAKE_MODE; }
});

test('al perder la propiedad del trabajo detiene el comando sin sobrescribir al nuevo dueño', async () => {
  process.env.FAKE_MODE = 'silent';
  const pool = operationPool((pool) => { pool.owns = false; });
  try {
    await runOnce(pool, { config, heartbeatMs: 25 });
    assert.equal(pool.finalized, false);
    assert.equal(pool.operation.status, 'running');
  } finally { delete process.env.FAKE_MODE; }
});

test('el error persistido y sus eventos nunca reciben la contraseña del proceso', async () => {
  process.env.FAKE_MODE = 'secret-fail';
  const pool = operationPool();
  try {
    await runOnce(pool, { config });
    assert.equal(pool.operation.status, 'failed');
    assert.match(pool.operation.error_message, /acceso rechazado/);
    assert.ok(!JSON.stringify(pool.events).includes('clave sensible'));
    assert.ok(!pool.operation.error_message.includes('clave sensible'));
  } finally { delete process.env.FAKE_MODE; }
});
