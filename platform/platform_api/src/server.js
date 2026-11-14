import { readConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { databaseErrorMessage } from './db/diagnostics.js';

let pool;
try {
  const config = readConfig();
  pool = createPool(config);
  await pool.query('SELECT filename FROM schema_migrations LIMIT 1');
  const server = createApp({ pool, config }).listen(
    config.PORT,
    config.HOST,
    () =>
      console.log(
        `API de plataforma: http://${config.HOST}:${config.PORT}/api/v1`,
      ),
  );
  server.on('error', async (error) => {
    console.error(databaseErrorMessage(error));
    await pool.end();
    process.exitCode = 1;
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await pool.end();
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(databaseErrorMessage(error));
  await pool?.end();
  process.exitCode = 1;
}
