import pg from 'pg';
import { readFileSync } from 'node:fs';

export function databaseSsl(config) {
  if (!config.DB_SSL) return false;
  const ssl = { rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED };
  if (config.DB_SSL_CA_FILE) {
    const url = new URL(config.DATABASE_URL);
    if (
      ['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw Object.assign(new Error('Configura SSL mediante DB_SSL_*.'), {
        code: 'DB_SSL_OPTIONS_CONFLICT',
      });
    }
    try {
      ssl.ca = readFileSync(config.DB_SSL_CA_FILE, 'utf8');
    } catch {
      throw Object.assign(
        new Error('No se pudo leer el certificado de PostgreSQL.'),
        { code: 'DB_CA_FILE_UNREADABLE' },
      );
    }
  }
  return ssl;
}

export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: databaseSsl(config),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', () =>
    console.error('Se perdió una conexión con PostgreSQL.'),
  );
  return pool;
}

export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
