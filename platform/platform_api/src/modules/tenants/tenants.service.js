import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { planCode } from '../plans/plans.service.js';

export const uuid = z.uuid();
export const tenantInput = z
  .object({
    tenant_id: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
        'Usa 3–40 letras minúsculas, números o guiones.',
      ),
    name: z.string().trim().min(1).max(150),
    env: z.enum(['test', 'prod']).default('test'),
    // P4: cualquier plan del catálogo (tabla plans), no solo los 3 de la semilla.
    plan: planCode,
    engine: z.enum(['terraform', 'tofu', 'pulumi', 'cloudformation']),
    contact_email: z
      .email()
      .max(255)
      .transform((value) => value.toLowerCase()),
    timezone: z
      .string()
      .max(100)
      .default('America/La_Paz')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('es', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Zona horaria IANA inválida.'),
    region: z
      .string()
      .regex(/^[a-z]{2}-[a-z]+-\d$/)
      .default('us-east-2'),
  })
  .strict();

const filters = z.object({
  q: z.string().trim().max(100).default(''),
  status: z
    .enum([
      'draft',
      'provisioning',
      'ready',
      'suspending',
      'suspended',
      'resuming',
      'deleting',
      'deleted',
      'failed',
    ])
    .optional(),
  env: z.enum(['test', 'prod']).optional(),
  plan: planCode.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listTenants(pool, user, query) {
  const input = filters.parse(query);
  const conditions = [];
  const parameters = [];
  const where = (sql, value) => {
    parameters.push(value);
    conditions.push(sql.replace('?', `$${parameters.length}`));
  };
  if (user.role !== 'platform_admin') where('id = ?::uuid', user.tenant_id);
  if (input.q) {
    parameters.push(`%${input.q}%`);
    conditions.push(
      `(name ILIKE $${parameters.length} OR tenant_id ILIKE $${parameters.length})`,
    );
  }
  for (const field of ['status', 'env', 'plan'])
    if (input[field]) where(`${field} = ?`, input[field]);
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM tenants ${clause}`,
    parameters,
  );
  const result = await pool.query(
    `SELECT * FROM tenants ${clause} ORDER BY created_at DESC, id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
    [...parameters, input.limit, input.offset],
  );
  return {
    items: result.rows,
    total: count.rows[0].total,
    limit: input.limit,
    offset: input.offset,
  };
}

export async function getTenant(pool, user, id) {
  uuid.parse(id);
  const result = await pool.query(
    'SELECT * FROM tenants WHERE id = $1 AND ($2::uuid IS NULL OR id = $2)',
    [id, user.role === 'platform_admin' ? null : user.tenant_id],
  );
  if (!result.rowCount)
    throw new HttpError(404, 'NOT_FOUND', 'No se encontró la institución.');
  return result.rows[0];
}

export async function registerTenant(pool, input) {
  const tenant = tenantInput.parse(input);
  const plan = await pool.query('SELECT 1 FROM plans WHERE code = $1', [tenant.plan]);
  if (!plan.rowCount)
    throw new HttpError(400, 'PLAN_NOT_FOUND', `El plan "${tenant.plan}" no existe en el catálogo.`);
  // plan_snapshot lo completa el trigger de la migración 004 con el plan vigente.
  const result = await pool.query(
    'INSERT INTO tenants(id, tenant_id, name, env, plan, engine, contact_email, timezone, region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [
      randomUUID(),
      tenant.tenant_id,
      tenant.name,
      tenant.env,
      tenant.plan,
      tenant.engine,
      tenant.contact_email,
      tenant.timezone,
      tenant.region,
    ],
  );
  return result.rows[0];
}

export async function tenantDetail(pool, user, id) {
  const tenant = await getTenant(pool, user, id);
  const [operations, deployments] = await Promise.all([
    pool.query(
      'SELECT * FROM operations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20',
      [id],
    ),
    pool.query(
      'SELECT * FROM deployments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10',
      [id],
    ),
  ]);
  return {
    ...tenant,
    operations: operations.rows,
    deployments: deployments.rows,
  };
}
