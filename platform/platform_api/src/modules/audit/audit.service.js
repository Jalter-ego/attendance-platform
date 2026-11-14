import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export async function recordAudit(client, actor, { action, tenantId = null, operationId = null, details = null }) {
  await client.query(
    'INSERT INTO audit_log(id,actor_id,tenant_id,operation_id,action,details) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), actor.id, tenantId, operationId, action, details],
  );
}

const filters = z.object({
  q: z.string().trim().max(100).default(''),
  env: z.enum(['test', 'prod']).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
});

export async function listAudit(pool, query) {
  const { q, env, status, limit, offset } = filters.parse(query);
  const { rows: [result] } = await pool.query(
    `WITH entries AS (
       SELECT o.id,t.tenant_id,t.env,u.name AS actor,o.type AS action,o.status,
              o.created_at,o.finished_at,o.error_message AS details,o.id AS operation_id
         FROM operations o JOIN users u ON u.id=o.initiated_by JOIN tenants t ON t.id=o.tenant_id
       UNION ALL
       SELECT a.id,t.tenant_id,t.env,u.name,a.action,'succeeded',a.created_at,a.created_at,a.details,a.operation_id
         FROM audit_log a JOIN users u ON u.id=a.actor_id LEFT JOIN tenants t ON t.id=a.tenant_id
     ), filtered AS (
       SELECT * FROM entries
        WHERE ($1='' OR strpos(lower(concat_ws(' ',tenant_id,actor,action,details)), lower($1)) > 0)
          AND ($2::text IS NULL OR env=$2) AND ($3::text IS NULL OR status=$3)
     )
     SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE((
       SELECT json_agg(page ORDER BY created_at DESC,id)
         FROM (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT $4 OFFSET $5) page
     ), '[]'::json) AS audit`,
    [q, env ?? null, status ?? null, limit, offset],
  );
  return { ...result, limit, offset };
}
