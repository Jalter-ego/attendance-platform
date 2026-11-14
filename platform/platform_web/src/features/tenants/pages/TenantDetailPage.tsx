import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { tenantsService } from '../services/tenants.service';
import { engineNames, planNames } from '../types';
import { operationsService } from '../../operations/services/operations.service';
import { OperationPanel } from '../../operations/components/OperationPanel';
import { useResource } from '../../../hooks/useResource';
import { useAuth } from '../../auth/hooks/useAuth';
import { StatusBadge } from '../../../components/StatusBadge';
import { Icon } from '../../../components/Icon';

export function TenantDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { user } = useAuth();
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
  const [actionError, setActionError] = useState(
    () => (location.state as { creationError?: string } | null)?.creationError ?? '',
  );
  const [pending, setPending] = useState(false);
  const selected =
    selection?.tenant === id ? selection.operation : data?.operations[0]?.id;
  async function start(kind: 'diagnostic' | 'create') {
    setActionError('');
    setPending(true);
    try {
      const operation =
        kind === 'diagnostic'
          ? await operationsService.diagnostic(id)
          : await operationsService.infra(id, { type: 'create' });
      setSelection({ tenant: id, operation: operation.id });
      reload();
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
  const urls = deployment?.outputs.urls;
  const canCreate = ['draft', 'failed'].includes(data.status);
  const versions = deployment
    ? [
        [engineNames[deployment.engine], deployment.tool_versions[deployment.engine]],
        ...(deployment.engine === 'cloudformation'
          ? [['SDK de AWS', deployment.tool_versions.aws_sdk], ['Plantilla (SHA-256)', deployment.tool_versions.template_sha256]]
          : [['Proveedor AWS', deployment.tool_versions.provider_aws]]),
        ['AMIs (Packer)', deployment.tool_versions.image_version ?? deployment.tool_versions.ami],
        ['Plantillas (commit)', deployment.tool_versions.templates_commit ?? deployment.tool_versions.templates],
      ]
    : [];
  return (
    <>
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
              <dd>{planNames[data.plan]}</dd>
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
            {urls?.frontend ? (
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
          {user?.role === 'platform_admin' && (
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
            <h2>Frontend, backend y base de datos en AWS</h2>
          </div>
          <Icon name="building" />
        </div>
        {deployment ? (
          <dl className="infra-versions">
            {versions.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? '—'}</dd>
              </div>
            ))}
            {deployment.outputs.stack_name && (
              <div>
                <dt>Stack</dt>
                <dd>{deployment.outputs.stack_name}</dd>
              </div>
            )}
            <div>
              <dt>Recursos</dt>
              <dd>
                {deployment.resources
                  .map((resource) => `${resource.role}: ${resource.id}`)
                  .join(' · ') || '—'}
              </dd>
            </div>
            <div>
              <dt>Último despliegue</dt>
              <dd>{new Date(deployment.created_at).toLocaleString('es-BO')}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">
            Todavía no hay despliegues. Al crear la infraestructura se ejecuta{' '}
            {engineNames[data.engine]} con las AMIs de Packer; cloud-init y
            Ansible configuran cada servidor.
          </p>
        )}
        {user?.role === 'platform_admin' && canCreate && (
          <>
            {!data.creation.available && (
              <p className="muted">{data.creation.message}</p>
            )}
            <button
              className="button primary"
              disabled={pending || busy || !data.creation.available}
              onClick={() => {
                void start('create');
              }}
            >
              {busy
                ? 'Hay una operación pendiente'
                : data.status === 'failed'
                  ? 'Reintentar instalación'
                  : 'Crear infraestructura'}
              <Icon name="arrow" size={17} />
            </button>
          </>
        )}
        {deployment?.status === 'failed' && (
          <p className="alert info">Se guardaron recursos de un intento anterior. La instalación todavía necesita completar su verificación.</p>
        )}
      </section>
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
            reload();
          }}
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
