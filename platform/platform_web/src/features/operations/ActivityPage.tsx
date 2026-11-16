import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useResource } from '../../hooks/useResource';
import { StatusBadge } from '../../components/StatusBadge';
import { operationLabels } from './types';
import type { Tenant } from '../tenants/types';

type Entry = { id: string; tenant_id: string | null; env: string | null; action: string; actor: string; status: string; details: string | null; created_at: string };
type Alert = { id: string; tenant_id: string; tenant_uuid: string; env: string; severity: string; message: string; detected_at: string };
const auditLabels: Record<string, string> = {
  'tenant-register': 'Registro de institución', 'tenant-admin-create': 'Alta de administrador',
  'tenant-admin-reset': 'Cambio de contraseña', 'tenant-admin-disable': 'Desactivación de administrador',
  'tenant-admin-enable': 'Reactivación de administrador', 'plan-create': 'Alta de plan',
  'plan-update': 'Edición de plan', 'plan-delete': 'Eliminación de plan', 'operation-cancel-request': 'Solicitud de cancelación',
};
const showEnv = (env: string | null) => env === 'prod' ? 'Producción' : env === 'test' ? 'Pruebas' : '';
const date = (value: string) => new Date(value).toLocaleString('es-BO');
const pageSize = 20;

export function AuditPage() {
  const [filters, setFilters] = useState({ q: '', env: '', status: '' });
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) if (value.trim()) query.set(key, value.trim());
  const url = `/audit?${query}`;
  const load = useCallback((signal: AbortSignal) => api<{ audit: Entry[]; total: number }>(url, { signal }), [url]);
  const audit = useResource(url, load, 4000);
  const rows = audit.data?.audit ?? [];
  const total = audit.data?.total ?? 0;

  function filter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setOffset(0);
  }

  return <>
    <div className="page-heading"><div><h1>Auditoría</h1><p>Operaciones, cambios de acceso y cambios del catálogo.</p></div></div>
    <section className="panel p6-panel">
      <div className="form-grid three-columns">
        <label>Buscar en auditoría<input type="search" maxLength={100} value={filters.q} onChange={(event) => filter('q', event.target.value)} placeholder="Tenant, acción o usuario" /></label>
        <label>Entorno<select value={filters.env} onChange={(event) => filter('env', event.target.value)}>
          <option value="">Todos</option><option value="test">Pruebas</option><option value="prod">Producción</option>
        </select></label>
        <label>Resultado<select value={filters.status} onChange={(event) => filter('status', event.target.value)}>
          <option value="">Todos</option><option value="succeeded">Completada</option><option value="failed">Fallida</option>
          <option value="queued">En cola</option><option value="running">En curso</option><option value="cancelled">Cancelada</option>
        </select></label>
      </div>
      {audit.error && <p role="alert" className="alert error">{audit.error}</p>}
      {audit.loading && <p>Cargando auditoría…</p>}
      {audit.data && !rows.length && <p>No se encontraron eventos.</p>}
      <ul className="p6-list">{rows.map((row) => <li key={row.id}>
        <div><strong>{auditLabels[row.action] || operationLabels[row.action] || row.action}</strong>
          <p>{row.tenant_id ?? 'Plataforma'} {showEnv(row.env)} · {row.actor} · {date(row.created_at)}</p>
          {row.details && <p>{row.details}</p>}
        </div><StatusBadge status={row.status} />
      </li>)}</ul>
      {(total > pageSize || offset > 0) && <div className="p6-actions">
        <button type="button" disabled={offset === 0} className="button" onClick={() => setOffset((value) => value - pageSize)}>Anterior</button>
        <button type="button" disabled={offset + pageSize >= total} className="button" onClick={() => setOffset((value) => value + pageSize)}>Siguiente</button>
      </div>}
    </section>
  </>;
}

const loadAlerts = (signal: AbortSignal) => api<{ alerts: Alert[] }>('/alerts', { signal });

function grafanaUrl(tenant?: Tenant) {
  const address = import.meta.env.VITE_GRAFANA_URL;
  if (!address) return undefined;
  try {
    const base = new URL(address);
    if (!['http:', 'https:'].includes(base.protocol)) return undefined;
    base.pathname = `${base.pathname.replace(/\/$/, '')}/d/attendance-tenants`;
    if (tenant) {
      base.searchParams.set('var-tenant', tenant.tenant_id);
      base.searchParams.set('var-env', tenant.env);
    }
    return base.href;
  } catch {
    return undefined;
  }
}

export function MonitoringPage() {
  const alerts = useResource('alerts', loadAlerts, 5000);
  const [page, setPage] = useState(0);
  const loadTenants = useCallback((signal: AbortSignal) => api<{ items: Tenant[]; total: number }>(
    `/tenants?exclude_deleted=true&limit=${pageSize}&offset=${page * pageSize}`, { signal }), [page]);
  const tenants = useResource(`monitoring:tenants:${page}`, loadTenants, 5000);
  const dashboard = grafanaUrl();
  return <>
    <div className="page-heading">
      <div><h1>Monitoreo</h1></div>
      {dashboard && <a className="button" href={dashboard} target="_blank" rel="noreferrer">Abrir Grafana</a>}
    </div>
    <section className="panel p6-panel">
      <h2>Estado de las instituciones</h2>
      {tenants.error && <p role="alert" className="alert error">{tenants.error}</p>}
      {tenants.loading && <p>Cargando instituciones…</p>}
      {tenants.data?.total === 0 && <p>Todavía no hay instituciones registradas.</p>}
      {!dashboard && <p>El enlace a Grafana aún no está configurado.</p>}
      <ul className="p6-list">{tenants.data?.items.map((tenant) => {
        const link = tenant.status === 'ready' ? grafanaUrl(tenant) : undefined;
        return <li key={tenant.id}>
          <div><Link className="text-link" to={`/tenants/${tenant.id}`}>{tenant.name}</Link>
            <p>{showEnv(tenant.env)}</p></div>
          <StatusBadge status={tenant.status} />
          {link && <a className="text-link" href={link} target="_blank" rel="noreferrer" aria-label={`Ver ${tenant.name} en Grafana`}>Grafana</a>}
        </li>;
      })}</ul>
      {((tenants.data?.total ?? 0) > pageSize || page > 0) && <div className="p6-actions">
        <button type="button" className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
        <button type="button" className="button" disabled={(page + 1) * pageSize >= (tenants.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Siguiente</button>
      </div>}
    </section>
    <section className="panel p6-panel">
      <h2>Alertas recientes</h2>
      {alerts.error && <p role="alert" className="alert error">{alerts.error}</p>}
      {alerts.loading && <p>Cargando alertas…</p>}
      {alerts.data?.alerts.length === 0 && <p>Todavía no hay alertas registradas.</p>}
      <ul className="p6-list">{alerts.data?.alerts.map((alert) => <li key={alert.id}>
        <div><strong>{alert.message}</strong><p><Link className="text-link" to={`/tenants/${alert.tenant_uuid}`}>{alert.tenant_id}</Link> · {showEnv(alert.env)} · {date(alert.detected_at)}</p></div>
        <span>{({ warning: 'Advertencia', critical: 'Crítica', info: 'Información' } as Record<string, string>)[alert.severity] || alert.severity}</span>
      </li>)}</ul>
    </section>
  </>;
}
