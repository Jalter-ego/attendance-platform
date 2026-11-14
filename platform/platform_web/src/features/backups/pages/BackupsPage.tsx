import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../../../hooks/useResource';
import { useAuth } from '../../auth/hooks/useAuth';
import { Icon } from '../../../components/Icon';
import { StatusBadge } from '../../../components/StatusBadge';
import { OperationPanel } from '../../operations/components/OperationPanel';
import { tenantsService } from '../../tenants/services/tenants.service';
import { backupsService } from '../services/backups.service';
import { backupTypeNames, type BackupItem } from '../types';
import './backups.css';

const backupTypes = ['backup', 'restore'];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('es-BO') : '—';
}

export function BackupsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'platform_admin';
  const [params, setParams] = useSearchParams();
  const tenantsFetcher = useCallback(
    (signal: AbortSignal) => tenantsService.list('limit=100', signal),
    [],
  );
  const tenants = useResource('backups:tenants', tenantsFetcher);
  const id = params.get('tenant') || tenants.data?.items[0]?.id || '';
  const tenant = tenants.data?.items.find((item) => item.id === id);

  const detailFetcher = useCallback(
    (signal: AbortSignal) => tenantsService.detail(id, signal),
    [id],
  );
  const detail = useResource(`backups:detail:${id}`, detailFetcher, 3000);
  const operations = (detail.data?.operations ?? []).filter((operation) =>
    backupTypes.includes(operation.type),
  );
  const busy = (detail.data?.operations ?? []).some((operation) =>
    ['queued', 'running'].includes(operation.status),
  );
  // La lista consulta AWS: se vuelve a pedir al terminar bien un respaldo o restauración.
  const lastDone =
    operations.find((operation) => operation.status === 'succeeded')?.id ??
    'none';
  const listFetcher = useCallback(
    (signal: AbortSignal) => backupsService.list(id, signal),
    [id],
  );
  const backups = useResource(`backups:list:${id}:${lastDone}`, listFetcher);

  const [selection, setSelection] = useState<{
    tenant: string;
    operation: string;
  } | null>(null);
  const selected =
    selection?.tenant === id ? selection.operation : operations[0]?.id;
  const [confirm, setConfirm] = useState<BackupItem | null>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');

  async function start(action: () => Promise<{ id: string }>) {
    setActionError('');
    setPending(true);
    try {
      const operation = await action();
      setSelection({ tenant: id, operation: operation.id });
      detail.reload();
      return true;
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'No se pudo iniciar la operación.',
      );
      return false;
    } finally {
      setPending(false);
    }
  }

  if (tenants.loading)
    return <div className="empty-state">Cargando instituciones…</div>;
  if (!tenants.data?.items.length)
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <Icon name="archive" size={30} />
        </span>
        <h2>Aún no hay instituciones</h2>
        <p>Registra y despliega una institución para administrar sus respaldos.</p>
      </div>
    );

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONTINUIDAD</span>
          <h1>Respaldos</h1>
          <p>
            Volcado de la base en S3 y snapshot del disco de datos, por
            institución y entorno.
          </p>
        </div>
        <select
          className="backup-tenant-select"
          aria-label="Seleccionar institución"
          value={id}
          onChange={(event) => setParams({ tenant: event.target.value })}
        >
          {tenants.data.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.tenant_id}/{item.env}
            </option>
          ))}
        </select>
      </div>
      {(actionError || detail.error) && (
        <p role="alert" className="alert error">
          {actionError || detail.error}
        </p>
      )}
      <div className="detail-grid">
        <section className="panel detail-summary">
          <div className="panel-heading">
            <h2>{tenant?.name ?? 'Institución'}</h2>
            <Icon name="building" />
          </div>
          <dl>
            <div>
              <dt>Identificador</dt>
              <dd>
                {tenant?.tenant_id}/{tenant?.env}
              </dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{tenant && <StatusBadge status={tenant.status} />}</dd>
            </div>
            <div>
              <dt>Bucket</dt>
              <dd className="backup-mono">{backups.data?.bucket ?? '—'}</dd>
            </div>
            <div>
              <dt>Respaldos</dt>
              <dd>{backups.data?.items.length ?? '—'}</dd>
            </div>
          </dl>
          <div className="detail-links">
            <Link className="text-link" to={`/tenants/${id}`}>
              Ver institución <Icon name="arrow" size={16} />
            </Link>
          </div>
        </section>
        <section className="panel integration-card">
          <span className="integration-icon">
            <Icon name="archive" size={27} />
          </span>
          <h2>Respaldar ahora</h2>
          <p>
            Crea un volcado lógico de la base (pg_dump) en S3 y un snapshot EBS
            del disco de datos. La aplicación sigue disponible.
          </p>
          <span className="helper-text">
            Necesita la VM db encendida. Los programados corren solos según el
            plan.
          </span>
          {tenant && tenant.status !== 'ready' && (
            <p role="status" className="backup-warning">
              Estado en la plataforma: <StatusBadge status={tenant.status} />.
              Si su infraestructura no está desplegada o está suspendida, el
              respaldo fallará.
            </p>
          )}
          {isAdmin && (
            <button
              className="button primary"
              disabled={pending || busy}
              onClick={() => {
                void start(() => backupsService.backup(id));
              }}
            >
              {pending
                ? 'Enviando…'
                : busy
                  ? 'Hay una operación pendiente'
                  : 'Respaldar ahora'}
              <Icon name="arrow" size={17} />
            </button>
          )}
        </section>
      </div>

      <div className="section-heading">
        <h2>Respaldos disponibles</h2>
        <span className="count-label">{backups.data?.items.length ?? 0}</span>
        <button
          className="icon-button bordered"
          onClick={backups.reload}
          aria-label="Actualizar respaldos"
          title="Actualizar"
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <section className="panel">
        {backups.loading ? (
          <div className="empty-state compact">Consultando S3 y EBS…</div>
        ) : backups.error ? (
          <div role="alert" className="alert error">
            {backups.error}
          </div>
        ) : !backups.data?.items.length ? (
          <div className="empty-state compact">
            <Icon name="archive" size={25} />
            <h3>Sin respaldos todavía</h3>
            <p>Usa «Respaldar ahora» o espera al respaldo programado.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Volcado (S3)</th>
                  <th>Snapshot (EBS)</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.data.items.map((item) => (
                  <tr key={item.backup_id}>
                    <td>
                      <strong>{formatDate(item.created_at)}</strong>
                      <small className="backup-id">{item.backup_id}</small>
                    </td>
                    <td>
                      {item.dump
                        ? (backupTypeNames[item.type] ?? item.type)
                        : 'Solo snapshot (DLM)'}
                    </td>
                    <td className="muted">
                      {item.dump ? formatBytes(item.dump.bytes) : '—'}
                    </td>
                    <td className="muted">
                      {item.snapshot ? (
                        <>
                          <span className="backup-mono">
                            {item.snapshot.snapshot_id}
                          </span>{' '}
                          · {item.snapshot.state}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {isAdmin && item.restorable && (
                        <button
                          className="button small"
                          disabled={pending || busy}
                          onClick={() => {
                            setTyped('');
                            setConfirm(item);
                          }}
                        >
                          Restaurar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="section-heading">
        <h2>Operaciones de respaldo</h2>
        <span className="count-label">{operations.length}</span>
      </div>
      {operations.length > 1 && (
        <div className="operation-tabs" aria-label="Seleccionar operación">
          {operations.map((operation) => (
            <button
              key={operation.id}
              className={selected === operation.id ? 'selected' : ''}
              onClick={() =>
                setSelection({ tenant: id, operation: operation.id })
              }
            >
              {operation.type === 'restore' ? 'Restauración' : 'Respaldo'} ·{' '}
              {new Date(operation.created_at).toLocaleString('es-BO')}
              <StatusBadge status={operation.status} />
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <OperationPanel
          key={selected}
          id={selected}
          onRetry={(operation) => {
            setSelection({ tenant: id, operation: operation.id });
            detail.reload();
          }}
        />
      ) : (
        <section className="panel empty-state compact">
          <Icon name="activity" size={25} />
          <h3>Sin operaciones de respaldo</h3>
          <p>El progreso y los registros de cada respaldo aparecerán aquí.</p>
        </section>
      )}

      {confirm && (
        <div
          className="backup-dialog-backdrop"
          role="presentation"
          onClick={() => setConfirm(null)}
        >
          <div
            className="backup-dialog panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="restore-title">Restaurar respaldo</h2>
            <p>
              La base de <strong>{tenant?.name}</strong> volverá al estado del{' '}
              <strong>{formatDate(confirm.created_at)}</strong>. Los cambios
              posteriores se pierden, pero antes se guarda una copia
              «previa a restaurar».
            </p>
            <label>
              Escribe <strong>{tenant?.tenant_id}</strong> para confirmar
              <input
                autoFocus
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            <div className="form-actions">
              <button className="button" onClick={() => setConfirm(null)}>
                Cancelar
              </button>
              <button
                className="button danger"
                disabled={typed !== tenant?.tenant_id || pending}
                onClick={() => {
                  const backupId = confirm.backup_id;
                  void start(() => backupsService.restore(id, backupId)).then(
                    (ok) => ok && setConfirm(null),
                  );
                }}
              >
                Restaurar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
