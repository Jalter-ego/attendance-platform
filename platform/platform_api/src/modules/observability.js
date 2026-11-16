import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import { getTenant, uuid } from './tenants/tenants.service.js';

export async function listAlerts(pool, user) {
  const { rows } = await pool.query(
    `SELECT a.id,t.tenant_id,t.env,t.id AS tenant_uuid,a.severity,a.message,a.detected_at FROM platform_alerts a
      JOIN tenants t ON t.id=a.tenant_id WHERE ($1::uuid IS NULL OR t.id=$1)
      ORDER BY a.detected_at DESC LIMIT 200`,
    [user.role === 'platform_admin' ? null : user.tenant_id],
  );
  return { alerts: rows };
}

export async function listScans(pool, user, id) {
  await getTenant(pool, user, id);
  const { rows } = await pool.query('SELECT * FROM platform_scans WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100', [id]);
  return { scans: rows };
}

export function authorizeService(config, authorization) {
  if (!config.PLATFORM_WEBHOOK_TOKEN)
    throw new HttpError(503, 'WEBHOOK_DISABLED', 'El receptor de eventos no está configurado.');
  const want = Buffer.from(`Bearer ${config.PLATFORM_WEBHOOK_TOKEN}`);
  const got = Buffer.from(authorization ?? '');
  if (want.length !== got.length || !timingSafeEqual(want, got))
    throw new HttpError(401, 'INVALID_SERVICE_TOKEN', 'Autorización de servicio inválida.');
}

export async function addAlert(pool, input) {
  const data = z.object({
    tenant_id: z.string().min(3).max(40), env: z.enum(['test','prod']),
    severity: z.string().trim().min(1).max(40), message: z.string().trim().min(1).max(1000),
    detected_at: z.iso.datetime({ offset: true }).optional(),
  }).strict().parse(input);
  const result = await pool.query(
    `INSERT INTO platform_alerts(tenant_id,severity,message,detected_at)
     SELECT id,$3,$4,COALESCE($5::timestamptz,now()) FROM tenants WHERE tenant_id=$1 AND env=$2 RETURNING id`,
    [data.tenant_id, data.env, redact(data.severity).slice(0,40), redact(data.message).slice(0,1000), data.detected_at ?? null],
  );
  if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', 'No se encontró la institución.');
  return result.rows[0];
}

const grafanaNotification = z.object({
  alerts: z.array(z.object({
    status: z.string(),
    fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/i),
    startsAt: z.iso.datetime({ offset: true }),
    labels: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.string()).optional(),
  })).max(1000),
});

export async function receiveAlerts(pool, input) {
  if (!input || !Object.hasOwn(input, 'alerts')) return addAlert(pool, input);

  const { alerts } = grafanaNotification.parse(input);
  const events = alerts
    .filter(({ status, labels }) => status === 'firing'
      && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(labels.tenant ?? '')
      && ['test', 'prod'].includes(labels.env))
    .map(({ labels, annotations, fingerprint, startsAt }) => ({
      tenant_id: labels.tenant,
      env: labels.env,
      severity: ['critical', 'warning', 'info'].includes(labels.severity) ? labels.severity : 'warning',
      message: redact(annotations?.summary || labels.alertname || 'Alerta de Grafana').slice(0, 1000),
      detected_at: startsAt,
      source_event: `grafana:${fingerprint}:${new Date(startsAt).toISOString()}`,
    }));
  if (!events.length) return { received: 0 };

  const result = await pool.query(
    `INSERT INTO platform_alerts(tenant_id,severity,message,detected_at,source_event)
     SELECT t.id,e.severity,e.message,e.detected_at,e.source_event
     FROM jsonb_to_recordset($1::jsonb)
       AS e(tenant_id text, env text, severity text, message text, detected_at timestamptz, source_event text)
     JOIN tenants t ON t.tenant_id=e.tenant_id AND t.env=e.env
     WHERE t.status NOT IN ('suspending','suspended','deleting','deleted')
     ON CONFLICT (tenant_id, source_event) DO NOTHING`,
    [JSON.stringify(events)],
  );
  return { received: result.rowCount };
}

export async function addScan(pool, id, input) {
  const data = z.object({
    scanner: z.string().trim().min(1).max(60), status: z.string().trim().min(1).max(40),
    findings: z.array(z.string().max(2000)).max(100),
  }).strict().parse(input);
  await getTenant(pool, { role: 'platform_admin' }, uuid.parse(id));
  const { rows } = await pool.query(
    'INSERT INTO platform_scans(tenant_id,scanner,status,findings) VALUES ($1,$2,$3,$4::jsonb) RETURNING id',
    [id, redact(data.scanner).slice(0,60), redact(data.status).slice(0,40), JSON.stringify(data.findings.map((finding) => redact(finding)))],
  );
  return rows[0];
}
