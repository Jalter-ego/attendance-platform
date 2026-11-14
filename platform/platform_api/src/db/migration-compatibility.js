// P2 y P6 publicaron migraciones 003 independientes y ambas ya pudieron aplicarse.
// Sus archivos y checksums se conservan. Solo cuando la migración hermana ya figura
// aplicada se ejecuta esta unión equivalente, evitando ADD COLUMN status duplicado
// y evitando quitar tipos de operación que ya pueden tener filas.
const siblings = {
  '003_create_deployments.sql': '003_engines.sql',
  '003_engines.sql': '003_create_deployments.sql',
};

export async function applyConcurrentMigration(client, filename) {
  const sibling = siblings[filename];
  if (!sibling) return false;
  const applied = await client.query('SELECT filename FROM schema_migrations WHERE filename=$1', [sibling]);
  if (!applied.rowCount) return false;
  await client.query(`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS health jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS log_ref varchar(100);
    ALTER TABLE operations DROP CONSTRAINT operations_type_check;
    ALTER TABLE operations ADD CONSTRAINT operations_type_check
      CHECK (type IN ('diagnostic', 'backup', 'restore', 'create', 'suspend', 'resume', 'destroy'));
  `);
  return true;
}
