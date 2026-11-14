import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { HttpError } from '../../lib/errors.js';

export const tokenHash = (token) =>
  createHash('sha256').update(token).digest('hex');
export const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  tenant_id: user.tenant_id,
});

export async function bootstrapAdmin(pool, input) {
  const admin = z
    .object({
      name: z.string().trim().min(1).max(150),
      email: z
        .email()
        .max(255)
        .transform((value) => value.toLowerCase()),
      password: z.string().min(12).max(128),
    })
    .parse(input);
  const passwordHash = await hashPassword(admin.password);
  return transaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('attendance-platform:initial-admin'))",
    );
    const existing = await client.query(
      "SELECT id FROM users WHERE role = 'platform_admin' AND active",
    );
    if (existing.rowCount) return false;
    await client.query(
      "INSERT INTO users(id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'platform_admin')",
      [randomUUID(), admin.name, admin.email, passwordHash],
    );
    return true;
  });
}

export async function login(pool, config, input) {
  const credentials = z
    .object({
      email: z
        .email()
        .max(255)
        .transform((value) => value.toLowerCase()),
      password: z.string().min(1).max(128),
    })
    .parse(input);
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1 AND active',
    [credentials.email],
  );
  const user = result.rows[0];
  if (!(await verifyPassword(credentials.password, user?.password_hash)))
    throw new HttpError(
      401,
      'INVALID_CREDENTIALS',
      'Correo o contraseña incorrectos.',
    );
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_HOURS * 3600000);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query(
    'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), user.id, expiresAt],
  );
  return { user: publicUser(user), token, expiresAt };
}

export function requireSession(pool) {
  return async (request, _response, next) => {
    const token = request.cookies.platform_session;
    if (typeof token !== 'string' || token.length > 100)
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Inicia sesión para continuar.',
      );
    const result = await pool.query(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active',
      [tokenHash(token)],
    );
    if (!result.rowCount)
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Tu sesión ha vencido. Vuelve a ingresar.',
      );
    request.user = publicUser(result.rows[0]);
    next();
  };
}

export function requireAdmin(request, _response, next) {
  if (request.user.role !== 'platform_admin')
    throw new HttpError(
      403,
      'FORBIDDEN',
      'Esta acción requiere un administrador de plataforma.',
    );
  next();
}
