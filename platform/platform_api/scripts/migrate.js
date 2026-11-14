import { readConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { databaseErrorMessage } from '../src/db/diagnostics.js';

let pool;
try {
  pool = createPool(readConfig());
  console.log(`Migraciones aplicadas: ${await migrate(pool)}`);
} catch (error) {
  console.error(
    error.message.startsWith('La migración')
      ? error.message
      : databaseErrorMessage(error),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
