import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { recordAudit } from '../audit/audit.service.js';
import { getTenant, uuid } from '../tenants/tenants.service.js';
import { newPassword, publicUser, userEmail, userName } from './auth.service.js';

const columns = 'id,name,email,role,tenant_id,active,created_at';
const publicTenantAdmin = (user) => ({ ...publicUser(user), active: user.active, created_at: user.created_at });
const createInput = z.strictObject({ name: userName, email: userEmail, password: newPassword });
const updateInput = z.strictObject({ active: z.boolean().optional(), password: newPassword.optional() })
  .refine(({ active, password }) => active !== undefined || password !== undefined, 'Indica el cambio de acceso.');

function assertTenantEditable(tenant) {
  if (['deleting', 'deleted'].includes(tenant.status))
    throw new HttpError(409, 'TENANT_DELETED', 'El tenant está eliminado o en proceso de eliminación.');
}

export async function listTenantAdmins(pool, actor, tenantId) {
  await getTenant(pool, actor, tenantId);
  const { rows } = await pool.query(
    `SELECT ${columns} FROM users WHERE role='tenant_admin' AND tenant_id=$1 ORDER BY active DESC,name,id`,
    [tenantId],
  );
  return { items: rows.map(publicTenantAdmin) };
}

export async function createTenantAdmin(pool, actor, tenantId, input) {
  const admin = createInput.parse(input);
  const passwordHash = await hashPassword(admin.password);
  return transaction(pool, async (client) => {
    const tenant = await getTenant(client, actor, tenantId, { lock: true });
    assertTenantEditable(tenant);
    const { rows: [user] } = await client.query(
      `INSERT INTO users(id,name,email,password_hash,role,tenant_id)
       VALUES ($1,$2,$3,$4,'tenant_admin',$5) RETURNING ${columns}`,
      [randomUUID(), admin.name, admin.email, passwordHash, tenant.id],
    );
    await recordAudit(client, actor, { tenantId, action: 'tenant-admin-create', details: user.email });
    return publicTenantAdmin(user);
  });
}

export async function updateTenantAdmin(pool, actor, tenantId, id, input) {
  uuid.parse(id);
  const { active, password } = updateInput.parse(input);
  const passwordHash = password === undefined ? null : await hashPassword(password);
  return transaction(pool, async (client) => {
    const tenant = await getTenant(client, actor, tenantId, { lock: true });
    assertTenantEditable(tenant);
    const { rows: [before] } = await client.query(
      `SELECT ${columns} FROM users WHERE id=$1 AND tenant_id=$2 AND role='tenant_admin' FOR UPDATE`,
      [id, tenantId],
    );
    if (!before) throw new HttpError(404, 'NOT_FOUND', 'No se encontró la cuenta del tenant.');
    const accessChanged = active !== undefined && active !== before.active;
    if (!accessChanged && !passwordHash) return publicTenantAdmin(before);
    const { rows: [user] } = await client.query(
      `UPDATE users SET active=COALESCE($2,active), password_hash=COALESCE($3,password_hash)
       WHERE id=$1 RETURNING ${columns}`,
      [id, active ?? null, passwordHash],
    );
    if (!user.active || passwordHash) await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    if (accessChanged) await recordAudit(client, actor, {
      tenantId, action: user.active ? 'tenant-admin-enable' : 'tenant-admin-disable', details: user.email,
    });
    if (passwordHash) await recordAudit(client, actor, {
      tenantId, action: 'tenant-admin-reset', details: user.email,
    });
    return publicTenantAdmin(user);
  });
}
