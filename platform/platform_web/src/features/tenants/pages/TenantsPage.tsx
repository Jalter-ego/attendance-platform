import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/hooks/useAuth';
import { useResource } from '../../../hooks/useResource';
import { tenantsService } from '../services/tenants.service';
import { planLabel } from '../types';
import { Icon } from '../../../components/Icon';
import { StatusBadge } from '../../../components/StatusBadge';

export function TenantsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = new URLSearchParams(params);
  filters.set('exclude_deleted', 'true');
  const query = filters.toString();
  const catalog = useResource('plans:tenant-filter', tenantsService.plans);
  const fetcher = useCallback(
    (signal: AbortSignal) => tenantsService.list(query, signal),
    [query],
  );
  const { data, loading, error, reload } = useResource(
    `tenants:${query}`,
    fetcher,
    5000,
  );
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.delete('offset');
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }
  const offset = data?.offset ?? 0;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TU ESPACIO DE TRABAJO</span>
          <h1>Instituciones</h1>
          <p>
            Administra cada instalación y consulta el estado de sus operaciones.
          </p>
        </div>
        {user?.role === 'platform_admin' && (
          <Link className="button primary" to="/tenants/new">
            <Icon name="plus" size={18} />
            Registrar institución
          </Link>
        )}
      </div>
      <div className="overview-strip">
        <span className="overview-icon">
          <Icon name="building" size={25} />
        </span>
        <div>
          <strong>
            {data?.total ?? '—'}{' '}
            <span>{data?.total === 1 ? 'institución' : 'instituciones'}</span>
          </strong>
          <p>
            {params.size
              ? 'Resultados de los filtros seleccionados'
              : 'Instalaciones independientes, una administración central'}
          </p>
        </div>
        <span className="overview-note">
          <span className="environment-dot" />
          Vista general
        </span>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <div className="search-field">
            <Icon name="search" size={18} />
            <input
              aria-label="Buscar institución"
              placeholder="Buscar por nombre o identificador…"
              value={params.get('q') || ''}
              onChange={(event) => filter('q', event.target.value)}
              maxLength={100}
            />
          </div>
          <select
            aria-label="Filtrar estado"
            value={params.get('status') || ''}
            onChange={(event) => filter('status', event.target.value)}
          >
            <option value="">Todos los estados</option>
            <option value="draft">Sin desplegar</option>
            <option value="ready">Disponible</option>
            <option value="suspended">Suspendida</option>
            <option value="failed">Fallida</option>
            <option value="deleted">Eliminada</option>
          </select>
          <select aria-label="Filtrar plan" value={params.get('plan') || ''} onChange={(event) => filter('plan', event.target.value)}>
            <option value="">Todos los planes</option>
            {catalog.data?.items.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
          </select>
          <select
            aria-label="Filtrar entorno"
            value={params.get('env') || ''}
            onChange={(event) => filter('env', event.target.value)}
          >
            <option value="">Todos los entornos</option>
            <option value="test">Pruebas</option>
            <option value="prod">Producción</option>
          </select>
          <button
            className="icon-button bordered"
            onClick={reload}
            aria-label="Actualizar listado"
            title="Actualizar"
          >
            <Icon name="refresh" size={18} />
          </button>
        </div>
        {error && (
          <div role="alert" className="alert error">
            {error}
          </div>
        )}
        {loading ? (
          <div className="empty-state">Cargando instituciones…</div>
        ) : !data?.items.length ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="building" size={30} />
            </span>
            <h2>
              {params.size
                ? 'No hay coincidencias'
                : 'Todo comienza con una institución'}
            </h2>
            <p>
              {params.size
                ? 'Prueba con otro nombre o ajusta los filtros.'
                : 'Las instituciones registradas aparecerán aquí, junto con sus operaciones.'}
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Institución</th>
                  <th>Plan</th>
                  <th>Entorno</th>
                  <th>Motor</th>
                  <th>Estado</th>
                  <th>
                    <span className="sr-only">Detalle</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <Link
                        className="tenant-name"
                        to={`/tenants/${tenant.id}`}
                      >
                        <span className="institution-avatar">
                          {tenant.name.slice(0, 1)}
                        </span>
                        <span>
                          <strong>{tenant.name}</strong>
                          <small>{tenant.tenant_id}</small>
                        </span>
                      </Link>
                    </td>
                    <td>{planLabel(tenant)}</td>
                    <td>
                      <span className="environment-label">
                        {tenant.env === 'test' ? 'Pruebas' : 'Producción'}
                      </span>
                    </td>
                    <td className="muted">{tenant.engine}</td>
                    <td>
                      <StatusBadge status={tenant.status} />
                    </td>
                    <td>
                      <Link
                        className="icon-button"
                        to={`/tenants/${tenant.id}`}
                        aria-label={`Ver ${tenant.name}`}
                      >
                        <Icon name="arrow" size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
          <div className="pagination">
            <span>
              {offset + 1}–{Math.min(offset + data.limit, data.total)} de{' '}
              {data.total} instituciones
            </span>
            <div>
              <button
                className="button small"
                disabled={!offset}
                onClick={() =>
                  setParams({
                    ...Object.fromEntries(params),
                    offset: String(Math.max(0, offset - data.limit)),
                  })
                }
              >
                Anterior
              </button>
              <button
                className="button small"
                disabled={offset + data.limit >= data.total}
                onClick={() =>
                  setParams({
                    ...Object.fromEntries(params),
                    offset: String(offset + data.limit),
                  })
                }
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
