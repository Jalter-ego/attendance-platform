import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { tenantsService } from '../services/tenants.service';
import { engineNames, planLabel, type TenantDetail } from '../types';
import { TenantActions } from '../TenantActions';
import { TenantAdminPanel, TenantSecurity } from '../TenantAdminPanel';
import { operationsService } from '../../operations/services/operations.service';
import { OperationPanel } from '../../operations/components/OperationPanel';
import { operationLabels, type Operation } from '../../operations/types';
import { useResource } from '../../../hooks/useResource';
import { useAuth } from '../../auth/hooks/useAuth';
import { StatusBadge } from '../../../components/StatusBadge';
import { Icon } from '../../../components/Icon';

const versionLabels: Record<string, string> = {
  aws_sdk: 'SDK de AWS', template_sha256: 'Plantilla (SHA-256)', provider_aws: 'Proveedor AWS',
  image_version: 'AMIs (Packer)', ami: 'AMIs (Packer)', templates_commit: 'Plantillas (commit)',
  templates: 'Plantillas (commit)', app: 'Aplicación', module: 'Módulo', engine: 'Motor',
};

function serviceHealth(deployment: TenantDetail['deployments'][number] | undefined) {
  const health = deployment?.health;
  if (health && typeof health.checks === 'object') {
    return {
      frontend: health.checks.frontend?.status === 200,
      backend: health.checks.backend?.status === 200,
      database: health.status === 'healthy',
    };
  }
  return deployment?.outputs.health ?? health;
}

export function TenantDetailPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const security = searchParams.get('tab') === 'security';
  const { user, mode } = useAuth();
  const engines = useResource('detail:engines', tenantsService.engines);
  const fetcher = useCallback(
    (signal: AbortSignal) => tenantsService.detail(id, signal),
    [id],
  );
  const { data, loading, error, reload } = useResource(
    `tenant:${id}`,
    fetcher,
    3000,
  );
  const [selection, setSelection] = useState<{
    tenant: string;
    operation: string;
  } | null>(null);
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const selected =
    selection?.tenant === id ? selection.operation : data?.operations[0]?.id;
  function selectOperation(operation: Operation) {
    setSelection({ tenant: id, operation: operation.id });
    reload();
  }
  async function start(kind: 'diagnostic' | 'create') {
    setActionError('');
    setPending(true);
    try {
      const operation =
        kind === 'diagnostic'
          ? await operationsService.diagnostic(id)
          : await operationsService.infra(id, { type: 'create' });
      selectOperation(operation);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'No se pudo iniciar la operación.',
      );
    } finally {
      setPending(false);
    }
  }
  if (loading) return <div className="empty-state">Cargando institución…</div>;
  if (!data)
    return (
      <div role="alert" className="alert error">
        {error || 'No se encontró la institución.'}
        <Link to="/tenants"> Volver al listado</Link>
      </div>
    );
  const busy = data.operations.some((operation) =>
    ['queued', 'running'].includes(operation.status),
  );
  const deployment = data.deployments[0];
  const urls = data.status === 'ready' ? deployment?.outputs.urls : undefined;
  const engine = engines.data?.items.find((item) => item.code === data.engine);
  const canCreate = data.status === 'draft' && data.creation.available;
  const health = serviceHealth(deployment);
  const isAdmin = user?.role === 'platform_admin';
  const heading = <>
      <Link className="back-link" to="/tenants">
        <Icon name="back" size={16} />
        Instituciones
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {data.tenant_id} · {data.env === 'test' ? 'PRUEBAS' : 'PRODUCCIÓN'}
          </span>
          <h1>{data.name}</h1>
          <p>{data.contact_email}</p>
        </div>
        <StatusBadge status={data.status} />
      </div>
      <nav className="p6-actions" aria-label="Vistas de la institución">
        <Link className="button" to="." aria-current={!security ? 'page' : undefined}>Resumen</Link>
        <Link className="button" to="?tab=security" aria-current={security ? 'page' : undefined}>Seguridad</Link>
      </nav>
  </>;

  if (security) return <>{heading}<TenantSecurity id={id} /></>;

  return (
    <>
      {heading}
      {(error || actionError) && (
        <p role="alert" className="alert error">
          {error || actionError}
        </p>
      )}
      <div className="detail-grid">
        <section className="panel detail-summary">
          <div className="panel-heading">
            <h2>Configuración</h2>
            <Icon name="building" />
          </div>
          <dl>
            <div>
              <dt>Plan</dt>
              <dd>
                {planLabel(data)}
                {data.plan_snapshot && ` · v${data.plan_snapshot.version}`}
              </dd>
            </div>
            <div>
              <dt>Motor</dt>
              <dd>{engineNames[data.engine]}</dd>
            </div>
            <div>
              <dt>Región</dt>
              <dd>{data.region}</dd>
            </div>
            <div>
              <dt>Zona horaria</dt>
              <dd>{data.timezone}</dd>
            </div>
            <div>
              <dt>Registrada</dt>
              <dd>{new Date(data.created_at).toLocaleDateString('es-BO')}</dd>
            </div>
          </dl>
          <div className="detail-links">
            <h3>Accesos</h3>
            {urls?.frontend?.startsWith('/demo/') && mode === 'local' ? (
              <Link className="text-link" to={urls.frontend}>Abrir demo de Attendance <Icon name="arrow" size={16} /></Link>
            ) : urls?.frontend && /^https?:\/\//.test(urls.frontend) ? (
              <a
                className="text-link"
                href={urls.frontend}
                target="_blank"
                rel="noreferrer"
              >
                Abrir Attendance <Icon name="arrow" size={16} />
              </a>
            ) : (
              <p className="muted">
                Los accesos aparecerán después del despliegue.
              </p>
            )}
            <Link className="text-link" to={`/backups?tenant=${id}`}>
              Respaldos <Icon name="arrow" size={16} />
            </Link>
          </div>
        </section>
        <section className="panel integration-card">
          <span className="integration-icon">
            <Icon name="activity" size={27} />
          </span>
          <h2>Comprueba la integración</h2>
          <p>
            Ejecuta una prueba para verificar el recorrido de las operaciones y
            consultar sus eventos.
          </p>
          <span className="helper-text">
            Esta prueba no crea ni modifica recursos en AWS.
          </span>
          {isAdmin && data.status !== 'deleted' && (
            <button
              className="button primary"
              disabled={pending || busy}
              onClick={() => {
                void start('diagnostic');
              }}
            >
              {pending
                ? 'Enviando…'
                : busy
                  ? 'Hay una operación pendiente'
                  : 'Ejecutar diagnóstico'}
              <Icon name="arrow" size={17} />
            </button>
          )}
        </section>
      </div>
      <section className="panel infra-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">INFRAESTRUCTURA</span>
            <h2>{mode === 'local' ? 'Frontend, backend y base de datos simulados' : 'Frontend, backend y base de datos en AWS'}</h2>
          </div>
          <Icon name="building" />
        </div>
        {deployment ? (
          <>
            {health && Object.keys(health).length > 0 && <dl className="infra-versions">
              {Object.entries(health).map(([key, value]) =>
                <div key={key}><dt>{{ frontend: 'Frontend', backend: 'Backend', database: 'Base de datos' }[key] || key}</dt><dd>{value === 'healthy' || value === true ? 'Disponible' : value === 'paused' ? 'Suspendido' : 'Por revisar'}</dd></div>)}
            </dl>}
            {data.deployments.map((entry, index) => <details className="p6-deployment" key={entry.id} open={index === 0 || undefined}>
              <summary>{engineNames[entry.engine]} · {new Date(entry.created_at).toLocaleString('es-BO')}</summary>
              <dl className="infra-versions">
                {Object.entries(entry.tool_versions).map(([key, value]) => <div key={key}><dt>{versionLabels[key] ?? key}</dt><dd>{value && typeof value === 'object' ? JSON.stringify(value) : value ?? '—'}</dd></div>)}
                {entry.outputs.stack_name && <div><dt>Stack de {engineNames[entry.engine]}</dt><dd>{entry.outputs.stack_name}</dd></div>}
                {Object.entries(entry.ami ?? {}).map(([key, value]) => <div key={key}><dt>AMI · {key}</dt><dd>{value}</dd></div>)}
                <div><dt>Recursos</dt><dd>{entry.resources.map((resource) => `${resource.role}: ${resource.id}`).join(' · ') || '—'}</dd></div>
              </dl>
            </details>)}
          </>
        ) : (
          <p className="muted">
            Todavía no hay despliegues guardados para este tenant.
          </p>
        )}
        {isAdmin && canCreate && (
          <button
            className="button primary"
            disabled={pending || busy}
            onClick={() => {
              void start('create');
            }}
          >
            {busy
              ? 'Hay una operación pendiente'
              : 'Crear infraestructura'}
            <Icon name="arrow" size={17} />
          </button>
        )}
        {isAdmin && data.status === 'draft' && !canCreate && <p>{data.creation.message}</p>}
        {deployment?.status === 'failed' && <p className="alert info">Se conservaron los recursos de un intento anterior. Revisa la operación antes de reintentar.</p>}
        {isAdmin && data.status === 'draft' && engines.error && <p role="alert" className="alert error">{engines.error}</p>}
      </section>
      {isAdmin && <TenantActions key={`actions:${id}`} tenant={data} supported={engine?.actions ?? []} busy={pending || busy} onQueued={selectOperation} />}
      {isAdmin && <TenantAdminPanel key={`admins:${id}`} tenant={data} />}
      <div className="section-heading">
        <h2>Operaciones</h2>
        <span className="count-label">{data.operations.length}</span>
      </div>
      {data.operations.length > 1 && (
        <div className="operation-tabs" aria-label="Seleccionar operación">
          {data.operations.map((operation) => (
            <button
              key={operation.id}
              className={selected === operation.id ? 'selected' : ''}
              onClick={() =>
                setSelection({ tenant: id, operation: operation.id })
              }
            >
              {operationLabels[operation.type] || operation.type} · {new Date(operation.created_at).toLocaleString('es-BO')}
              <StatusBadge status={operation.status} />
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <OperationPanel
          key={selected}
          id={selected}
          onRetry={selectOperation}
        />
      ) : (
        <section className="panel empty-state compact">
          <Icon name="activity" size={25} />
          <h3>Aún no hay operaciones</h3>
          <p>Inicia un diagnóstico para ver el progreso y los eventos aquí.</p>
        </section>
      )}
    </>
  );
}
