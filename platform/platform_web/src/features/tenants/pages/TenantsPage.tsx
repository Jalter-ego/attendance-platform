import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/hooks/useAuth';
import { useResource } from '../../../hooks/useResource';
import { tenantsService } from '../services/tenants.service';
import { engineNames, planLabel } from '../types';
import { Icon } from '../../../components/Icon';
import { StatusBadge } from '../../../components/StatusBadge';
import './tenants.css';

const filterKeys = ['q', 'status', 'plan', 'env'] as const;

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
  const { data, loading, error, reload } = useResource(`tenants:${query}`, fetcher, 5000);
  const hasFilters = filterKeys.some((key) => params.get(key));
  const offset = data?.offset ?? 0;
  const isAdmin = user?.role === 'platform_admin';

  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.delete('offset');
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  function clearFilters() {
    const next = new URLSearchParams(params);
    for (const key of filterKeys) next.delete(key);
    next.delete('offset');
    setParams(next, { replace: true });
  }

  function changePage(nextOffset: number) {
    const next = new URLSearchParams(params);
    next.set('offset', String(nextOffset));
    setParams(next);
  }

  return (
    <div className="tenant-directory">
      <div className="tenant-directory-heading">
        <div>
          <p className="tenant-directory-kicker">Tu espacio de trabajo</p>
          <h1>Instituciones</h1>
          <p>Todos tus espacios, con su información y estado en un mismo lugar.</p>
        </div>
        {isAdmin && (
          <Link className="button primary tenant-register" to="/tenants/new">
            <Icon name="plus" size={18} />Registrar institución
          </Link>
        )}
      </div>

      <section className="tenant-directory-panel" aria-labelledby="directory-title">
        <div className="tenant-directory-panel-heading">
          <div className="tenant-directory-title">
            <h2 id="directory-title">Directorio de instituciones</h2>
            {data && <span className="tenant-directory-count">{data.total}</span>}
          </div>
          <div className="tenant-directory-updates">
            <span>{error ? 'Actualización pendiente' : 'Actualización automática'}</span>
            <button className="tenant-refresh" onClick={reload} aria-label="Actualizar listado" title="Actualizar listado" disabled={loading}>
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </div>

        <div className="tenant-directory-toolbar">
          <label className="tenant-search-control">
            <span>Buscar institución</span>
            <span className="tenant-search-input">
              <Icon name="search" size={18} />
              <input type="search" placeholder="Nombre o identificador…" value={params.get('q') || ''} onChange={(event) => filter('q', event.target.value)} maxLength={100} />
            </span>
          </label>
          <label className="tenant-filter-control">
            <span>Estado</span>
            <select aria-label="Filtrar estado" value={params.get('status') || ''} onChange={(event) => filter('status', event.target.value)}>
              <option value="">Todos los estados</option>
              <option value="draft">Sin desplegar</option>
              <option value="ready">Disponible</option>
              <option value="suspended">Suspendida</option>
              <option value="failed">Fallida</option>
              <option value="deleted">Eliminada</option>
            </select>
          </label>
          <label className="tenant-filter-control">
            <span>Plan</span>
            <select aria-label="Filtrar plan" value={params.get('plan') || ''} onChange={(event) => filter('plan', event.target.value)}>
              <option value="">Todos los planes</option>
              {catalog.data?.items.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
            </select>
          </label>
          <label className="tenant-filter-control tenant-environment-filter">
            <span>Entorno</span>
            <select aria-label="Filtrar entorno" value={params.get('env') || ''} onChange={(event) => filter('env', event.target.value)}>
              <option value="">Todos los entornos</option>
              <option value="test">Pruebas</option>
              <option value="prod">Producción</option>
            </select>
          </label>
        </div>

        {catalog.error && (
          <div className="tenant-filter-feedback" role="alert">
            No se pudo cargar el catálogo de planes.
            <button className="tenant-text-button" onClick={catalog.reload}>Reintentar</button>
          </div>
        )}
        {hasFilters && (
          <div className="tenant-active-filters">
            <span>Resultados filtrados</span>
            <button className="tenant-text-button" onClick={clearFilters}><Icon name="close" size={14} />Limpiar filtros</button>
          </div>
        )}
        {error && data && <p role="alert" className="alert error tenant-directory-error">No se pudo actualizar el listado. {error}</p>}

        {loading ? (
          <div className="tenant-directory-loading" role="status">
            <span className="sr-only">Cargando instituciones…</span>
            {[0, 1, 2, 3].map((row) => <div className="tenant-loading-row" key={row} aria-hidden="true"><span /><span /><span /></div>)}
          </div>
        ) : error && !data ? (
          <div className="tenant-directory-empty" role="alert">
            <span className="tenant-empty-icon"><Icon name="refresh" size={27} /></span>
            <h3>No pudimos cargar las instituciones</h3>
            <p>{error}</p>
            <button className="button" onClick={reload}><Icon name="refresh" size={16} />Volver a intentar</button>
          </div>
        ) : data && data.total > 0 && !data.items.length ? (
          <div className="tenant-directory-empty">
            <span className="tenant-empty-icon"><Icon name="building" size={28} /></span>
            <h3>No hay instituciones en esta página</h3>
            <p>El listado cambió. Vuelve a la primera página para consultar las instituciones disponibles.</p>
            <button className="button" onClick={() => changePage(0)}>Ir a la primera página<Icon name="arrow" size={16} /></button>
          </div>
        ) : !data?.items.length ? (
          <div className="tenant-directory-empty">
            <span className="tenant-empty-icon"><Icon name={hasFilters ? 'search' : 'building'} size={28} /></span>
            <h3>{hasFilters ? 'No hay coincidencias' : isAdmin ? 'Tu primera institución empieza aquí' : 'Todavía no hay instituciones'}</h3>
            <p>{hasFilters ? 'Prueba con otro nombre o ajusta los filtros para encontrar una institución.' : isAdmin ? 'Las instituciones que registres aparecerán aquí con su plan, entorno y estado.' : 'Cuando tengas una institución asignada, aparecerá aquí con su plan, entorno y estado.'}</p>
            {hasFilters ? (
              <button className="button" onClick={clearFilters}>Limpiar filtros<Icon name="arrow" size={16} /></button>
            ) : isAdmin && (
              <Link className="button" to="/tenants/new">Registrar institución<Icon name="arrow" size={16} /></Link>
            )}
          </div>
        ) : (
          <div className="tenant-directory-table" tabIndex={0} role="region" aria-label="Listado de instituciones">
            <table>
              <caption className="sr-only">Instituciones registradas, sus planes, entornos, motores y estados.</caption>
              <thead>
                <tr>
                  <th scope="col">Institución</th><th scope="col">Plan</th><th scope="col">Entorno</th><th scope="col">Motor</th><th scope="col">Estado</th>
                  <th scope="col"><span className="sr-only">Detalle</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <Link className="tenant-directory-name" to={`/tenants/${tenant.id}`}>
                        <span className="tenant-directory-initials" aria-hidden="true">{tenant.name.slice(0, 2).toUpperCase()}</span>
                        <span><strong>{tenant.name}</strong><small>{tenant.tenant_id}</small></span>
                      </Link>
                    </td>
                    <td className="tenant-directory-plan">{planLabel(tenant)}</td>
                    <td><span className="tenant-directory-environment" data-environment={tenant.env}>{tenant.env === 'test' ? 'Pruebas' : 'Producción'}</span></td>
                    <td className="tenant-directory-engine">{engineNames[tenant.engine] ?? tenant.engine}</td>
                    <td><StatusBadge status={tenant.status} /></td>
                    <td><Link className="tenant-detail-link" to={`/tenants/${tenant.id}`} aria-label={`Ver ${tenant.name}`}><Icon name="arrow" size={18} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > 0 && data.items.length > 0 && (
          <div className="tenant-directory-pagination">
            <p><strong>{offset + 1}–{Math.min(offset + data.items.length, data.total)}</strong> de {data.total} {data.total === 1 ? 'institución' : 'instituciones'}</p>
            <div>
              <button className="button small" disabled={!offset} onClick={() => changePage(Math.max(0, offset - data.limit))}><Icon name="back" size={15} />Anterior</button>
              <button className="button small" disabled={offset + data.limit >= data.total} onClick={() => changePage(offset + data.limit)}>Siguiente<Icon name="arrow" size={15} /></button>
            </div>
          </div>
        )}
      </section>
      <p className="tenant-directory-note"><Icon name="building" size={15} />Cada institución conserva su propio entorno y configuración.</p>
    </div>
  );
}
