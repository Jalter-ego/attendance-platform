import { readConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { databaseErrorMessage } from '../src/db/diagnostics.js';

let pool;
try {
  pool = createPool(readConfig());
  await pool.query('SELECT 1');
  console.log('Conexión con PostgreSQL verificada.');
} catch (error) {
  console.error(databaseErrorMessage(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
