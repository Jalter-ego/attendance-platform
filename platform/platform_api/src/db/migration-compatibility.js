// Las tres migraciones 003 nacieron en ramas distintas y excluyen tipos de las
// demás. La unión de 004/007 se aplica bajo la misma transacción del migrador.
// Aquí solo se omiten esas restricciones intermedias, sin cambiar sus checksums.
const siblings = {
  '003_create_deployments.sql': {
    filename: '003_engines.sql',
    columns: "ADD COLUMN IF NOT EXISTS health jsonb NOT NULL DEFAULT '{}'",
  },
  '003_engines.sql': {
    filename: '003_create_deployments.sql',
    columns: 'ADD COLUMN IF NOT EXISTS log_ref varchar(100)',
  },
};
const provisioning = '003_provisioning.sql';
const legacyConstraint = /ALTER TABLE operations DROP CONSTRAINT operations_type_check;\s*ALTER TABLE operations ADD CONSTRAINT operations_type_check\s+CHECK \(type IN \([^;]+\)\);/;

export async function applyMigration(client, filename, sql) {
  const sibling = siblings[filename];
  if (!sibling && filename !== provisioning) {
    await client.query(sql);
    return;
  }
  if (sibling) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [sibling.filename]);
    if (applied.rowCount) {
      // Las dos migraciones definen deployments.status. La primera lo crea.
      await client.query(`ALTER TABLE deployments ${sibling.columns}`);
      return;
    }
  }
  if (!legacyConstraint.test(sql))
    throw new Error(`La transición de tipos de operación requiere revisar ${filename}.`);
  await client.query(sql.replace(legacyConstraint, ''));
}
