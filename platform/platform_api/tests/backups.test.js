import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import {
  mergeBackups,
  runBackupScript,
  ScriptError,
} from '../src/modules/backups/backups.service.js';

const config = {
  ...readConfig({ DATABASE_URL: 'postgresql://unused' }),
  BACKUP_SCRIPT: fileURLToPath(
    new URL('./fixtures/fake-backup.sh', import.meta.url),
  ),
};
const tenant = { tenant_id: 'demo', env: 'test', region: 'us-east-2' };

function withMode(mode, fn) {
  return async () => {
    process.env.FAKE_MODE = mode;
    try {
      await fn();
    } finally {
      delete process.env.FAKE_MODE;
    }
  };
}

test(
  'runBackupScript devuelve el JSON final y entrega las líneas en orden',
  withMode('ok', async () => {
    const lines = [];
    const result = await runBackupScript(config, 'restore', tenant, {
      backupId: 'latest',
      onLine: (line) => lines.push(line),
    });
    assert.equal(result.backup_id, '20261114T150000Z-manual');
    assert.match(
      result.args,
      /^restore --tenant demo --env test --region us-east-2 --timeout \d+ --id latest$/,
    );
    assert.match(lines[0], /^== SSM /);
    assert.match(lines[3], /^== respaldo /);
  }),
);

test(
  'runBackupScript convierte el ERROR del script en ScriptError legible',
  withMode('fail', async () => {
    await assert.rejects(
      runBackupScript(config, 'backup', tenant),
      (error) =>
        error instanceof ScriptError &&
        error.message.startsWith('no hay una VM db en ejecución'),
    );
  }),
);

test(
  'runBackupScript corta el proceso si onLine falla (p. ej. cancelación)',
  withMode('slow', async () => {
    class Cancelled extends Error {}
    const started = Date.now();
    await assert.rejects(
      runBackupScript(config, 'backup', tenant, {
        onLine: () => {
          throw new Cancelled();
        },
      }),
      Cancelled,
    );
    assert.ok(Date.now() - started < 15000, 'el proceso debe terminar antes');
  }),
);

test('runBackupScript informa si no encuentra bash', async () => {
  await assert.rejects(
    runBackupScript({ ...config, BACKUP_BASH: 'no-existe-bash' }, 'list', tenant),
    (error) =>
      error instanceof ScriptError && /Configura BACKUP_BASH/.test(error.message),
  );
});

test('mergeBackups une dumps y snapshots por backup_id y ordena por fecha', () => {
  const items = mergeBackups({
    dumps: [
      {
        key: 'tenants/demo/test/db/20261113T100000Z-scheduled.dump',
        bytes: 10,
        last_modified: '2026-11-13T10:00:05Z',
      },
      {
        key: 'tenants/demo/test/db/20261114T150000Z-manual.dump',
        bytes: 20,
        last_modified: '2026-11-14T15:00:05Z',
      },
      { key: 'tenants/demo/test/db/otro-archivo.txt', bytes: 1 },
    ],
    snapshots: [
      {
        snapshot_id: 'snap-1',
        state: 'completed',
        gib: 10,
        started: '2026-11-14T15:00:10Z',
        backup_id: '20261114T150000Z-manual',
        type: 'manual',
      },
      {
        snapshot_id: 'snap-dlm',
        state: 'completed',
        gib: 10,
        started: '2026-11-12T03:00:00Z',
        backup_id: null,
        type: null,
      },
    ],
  });
  assert.deepEqual(
    items.map((item) => [item.backup_id, item.type, item.restorable]),
    [
      ['20261114T150000Z-manual', 'manual', true],
      ['20261113T100000Z-scheduled', 'scheduled', true],
      ['snap-dlm', 'scheduled', false],
    ],
  );
  assert.equal(items[0].snapshot.snapshot_id, 'snap-1');
  assert.equal(items[0].dump.bytes, 20);
  assert.equal(items[0].created_at, '2026-11-14T15:00:00Z');
});
