import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { transaction } from './pool.js';
import { applyMigration } from './migration-compatibility.js';

export async function migrate(pool) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  return transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('attendance-platform:migrations'))",
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    let applied = 0;
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [file],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(
            `La migración ${file} ya aplicada fue modificada. Crea otra migración.`,
          );
        continue;
      }
      await applyMigration(client, file, sql);
      await client.query(
        'INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      applied += 1;
    }
    return applied;
  });
}
