// Catálogo de planes (P4 · F1/F2, RF-01/02/04).
//
// Un plan define el cómputo y el disco de las 3 VMs (sizing), los límites de uso que hace
// cumplir attendance-core (limits → PLAN_MAX_*) y el respaldo (backup). Las reglas son las
// del módulo infra/terraform/tenant (P1); la migración 004 las repite como red de seguridad.
//
// Editar un plan NO cambia los tenants existentes: cada tenant guarda su copia
// (tenants.plan_snapshot) y los motores despliegan esa copia. Si se aplicaran los límites
// nuevos, cambiaría el user_data y el siguiente suspend/resume recrearía sus EC2. Para
// llevar un tenant a la versión nueva hace falta un cambio de plan explícito (RF-06).
import { z } from 'zod';
import { transaction } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';

export const PLAN_CODE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const planCode = z
  .string()
  .regex(PLAN_CODE, 'Código de plan: 3–40 letras minúsculas, números o guiones; empieza con letra.');

export const INSTANCE_SIZES = ['t3.micro', 't3.small', 't3.medium', 't3.large'];
export const BACKUP_POLICIES = [
  { schedule: 'weekly', retention_days: 28 },
  { schedule: 'daily', retention_days: 14 },
  { schedule: 'daily', retention_days: 30 },
];
// El módulo no fija un máximo; este tope evita un disco caro por un error de tipeo.
export const MAX_DB_DISK_GB = 1000;

const size = z.enum(INSTANCE_SIZES, {
  error: `Tamaño permitido: ${INSTANCE_SIZES.join(', ')}.`,
});
const limit = z
  .number()
  .int('Debe ser un número entero.')
  .min(1, 'Debe ser al menos 1. Para no limitar, deja el campo vacío.')
  .max(1_000_000);

const planBody = z
  .object({
    name: z.string().trim().min(1, 'El nombre es obligatorio.').max(100),
    description: z.string().trim().max(300).default(''),
    sizing: z
      .object({
        frontend: size,
        backend: size,
        db: size,
        db_disk_gb: z
          .number()
          .int('El disco debe ser un número entero de GB.')
          .min(10, 'El disco de la base debe tener al menos 10 GB.')
          .max(MAX_DB_DISK_GB, `El disco de la base admite hasta ${MAX_DB_DISK_GB} GB.`),
      })
      .strict(),
    // Sin una clave = sin límite para ese recurso.
    limits: z
      .object({
        max_students: limit.optional(),
        max_teachers: limit.optional(),
        max_courses: limit.optional(),
      })
      .strict()
      .default({}),
    backup: z
      .object({
        schedule: z.enum(['weekly', 'daily']),
        retention_days: z.number().int(),
      })
      .strict()
      .refine(
        (backup) =>
          BACKUP_POLICIES.some(
            (allowed) =>
              allowed.schedule === backup.schedule &&
              allowed.retention_days === backup.retention_days,
          ),
        'Respaldo permitido: semanal con 28 días, diario con 14 días o diario con 30 días.',
      ),
  })
  .strict();

export const createPlanInput = planBody.extend({ code: planCode }).strict();
// version: la que vio quien edita. Si otro la cambió antes, se rechaza (no pisa cambios).
export const updatePlanInput = planBody.extend({ version: z.number().int().min(1) }).strict();

// Tenants que cuentan: los eliminados ya no tienen infraestructura.
const LIVE = "t.status <> 'deleted'";

const PLAN_COLUMNS = `p.code, p.name, p.description, p.sizing, p.limits, p.backup, p.version,
  p.created_at, p.updated_at, p.updated_by`;

const usageSql = `
  SELECT ${PLAN_COLUMNS},
    json_build_object(
      'total', count(t.id) FILTER (WHERE ${LIVE}),
      'outdated', count(t.id) FILTER (WHERE ${LIVE} AND (t.plan_snapshot->>'version')::int < p.version)
    ) AS tenants
  FROM plans p LEFT JOIN tenants t ON t.plan = p.code`;

export async function listPlans(pool) {
  const result = await pool.query(
    `${usageSql} GROUP BY p.code ORDER BY (p.sizing->>'db_disk_gb')::int, p.code`,
  );
  return { items: result.rows };
}

export async function getPlan(pool, code) {
  planCode.parse(code);
  const plan = await pool.query(`${usageSql} WHERE p.code = $1 GROUP BY p.code`, [code]);
  if (!plan.rowCount) throw new HttpError(404, 'NOT_FOUND', 'No se encontró el plan.');
  const tenants = await pool.query(
    `SELECT t.id, t.tenant_id, t.env, t.name, t.status, (t.plan_snapshot->>'version')::int AS plan_version
     FROM tenants t WHERE t.plan = $1 AND ${LIVE} ORDER BY t.tenant_id, t.env`,
    [code],
  );
  return { ...plan.rows[0], tenant_list: tenants.rows };
}

export async function createPlan(pool, user, input) {
  const plan = createPlanInput.parse(input);
  await pool.query(
    `INSERT INTO plans(code, name, description, sizing, limits, backup, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [plan.code, plan.name, plan.description, plan.sizing, plan.limits, plan.backup, user.id],
  );
  return getPlan(pool, plan.code);
}

const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

/**
 * Reemplaza el plan y sube su versión. Devuelve cuántos tenants vivos siguen en una versión
 * anterior y un aviso para mostrar: sus límites, tamaños y respaldo NO cambian.
 */
export async function updatePlan(pool, user, code, input) {
  planCode.parse(code);
  const next = updatePlanInput.parse(input);
  const { plan, changed } = await transaction(pool, async (client) => {
    const current = await client.query('SELECT * FROM plans WHERE code = $1 FOR UPDATE', [code]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', 'No se encontró el plan.');
    const row = current.rows[0];
    if (row.version !== next.version)
      throw new HttpError(
        409,
        'PLAN_CHANGED',
        `Otra persona guardó el plan mientras lo editabas (versión ${row.version}). Recarga y vuelve a aplicar tus cambios.`,
      );
    const fields = ['name', 'description', 'sizing', 'limits', 'backup'];
    if (fields.every((field) => same(row[field], next[field])))
      return { plan: row, changed: false };
    const updated = await client.query(
      `UPDATE plans SET name = $2, description = $3, sizing = $4, limits = $5, backup = $6,
         version = version + 1, updated_at = now(), updated_by = $7
       WHERE code = $1 RETURNING *`,
      [code, next.name, next.description, next.sizing, next.limits, next.backup, user.id],
    );
    return { plan: updated.rows[0], changed: true };
  });
  const detail = await getPlan(pool, code);
  const unchanged = detail.tenant_list.filter((tenant) => tenant.plan_version < plan.version);
  return {
    plan: detail,
    changed,
    unchanged_tenants: unchanged.length,
    warning:
      changed && unchanged.length
        ? `${unchanged.length} tenant(s) con el plan ${plan.name} siguen con la versión anterior: sus límites, tamaños y respaldo no se modificaron. Los cambios aplican a los tenants nuevos; para un tenant existente hace falta un cambio de plan (puede recrear sus servidores).`
        : null,
  };
}

/** Solo se elimina un plan que ningún tenant usa (ni siquiera uno eliminado: historial). */
export async function deletePlan(pool, code) {
  planCode.parse(code);
  return transaction(pool, async (client) => {
    const current = await client.query('SELECT code FROM plans WHERE code = $1 FOR UPDATE', [code]);
    if (!current.rowCount) throw new HttpError(404, 'NOT_FOUND', 'No se encontró el plan.');
    const used = await client.query('SELECT count(*)::int AS n FROM tenants WHERE plan = $1', [code]);
    if (used.rows[0].n)
      throw new HttpError(
        409,
        'PLAN_IN_USE',
        `No se puede eliminar: ${used.rows[0].n} tenant(s) lo usan o lo usaron. Puedes editarlo en su lugar.`,
      );
    await client.query('DELETE FROM plans WHERE code = $1', [code]);
  });
}
