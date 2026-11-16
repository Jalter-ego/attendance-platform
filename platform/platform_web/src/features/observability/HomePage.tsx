import { Link } from 'react-router-dom';
import { useResource } from '../../hooks/useResource';
import { api } from '../../lib/api';
import { useAuth } from '../auth/hooks/useAuth';

const counts = [
  { label: 'Instituciones registradas', query: 'exclude_deleted=true' },
  { label: 'Instituciones activas', query: 'status=ready' },
  { label: 'Instituciones suspendidas', query: 'status=suspended' },
];

const load = (signal: AbortSignal) => Promise.all(counts.map(async (item) => ({
  ...item,
  total: (await api<{ total: number }>(`/tenants?${item.query}&limit=1`, { signal })).total,
})));

export function HomePage() {
  const { user } = useAuth();
  const summary = useResource('home:counts', load, 10000);

  return <>
    <div className="page-heading"><div><h1>Inicio</h1></div></div>
    {summary.error && <p role="alert" className="alert error">{summary.error}</p>}
    {summary.loading && <p>Cargando instituciones…</p>}
    <div className="form-grid three-columns">
      {summary.data?.map(({ label, total }) => <section className="panel p6-panel" key={label}>
        <h2>{label}</h2>
        <p>{total}</p>
      </section>)}
    </div>
    <div className="p6-actions">
      <Link className="button" to="/tenants">Ver instituciones</Link>
      {user?.role === 'platform_admin' && <Link className="button" to="/monitoring">Ver monitoreo y alertas</Link>}
    </div>
  </>;
}
