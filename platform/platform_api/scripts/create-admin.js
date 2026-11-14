import { readConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { bootstrapAdmin } from '../src/modules/auth/auth.service.js';
import { databaseErrorMessage } from '../src/db/diagnostics.js';

let pool;
try {
  pool = createPool(readConfig());
  const created = await bootstrapAdmin(pool, {
    name: process.env.BOOTSTRAP_ADMIN_NAME,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  console.log(
    created
      ? 'Administrador inicial creado.'
      : 'Ya existe un administrador activo. No se modificó su contraseña.',
  );
} catch (error) {
  console.error(databaseErrorMessage(error));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
