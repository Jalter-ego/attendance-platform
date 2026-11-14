// Pantalla Planes (P4 · F4, RF-01/RF-04): catálogo, uso por institución y edición versionada.
import { useCallback, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useResource } from '../../../hooks/useResource';
import { useAuth } from '../../auth/hooks/useAuth';
import { PlanEditor } from '../components/PlanEditor';
import { plansService } from '../services/plans.service';
import { backupLabel, LIMIT_FIELDS, type CatalogPlan } from '../types';
import './plans.css';

const number = (value?: number) => (value === undefined ? 'Sin límite' : value.toLocaleString('es-BO'));

export function PlansPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'platform_admin';
  const fetchPlans = useCallback((signal: AbortSignal) => plansService.list(signal), []);
  const plans = useResource('plans:catalog', fetchPlans);
  const [editor, setEditor] = useState<{ plan?: CatalogPlan } | null>(null);
  const [deleting, setDeleting] = useState<CatalogPlan | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function remove(plan: CatalogPlan) {
    setPending(true);
    setError('');
    try {
      await plansService.remove(plan.code);
      setNotice(`Plan ${plan.name} eliminado.`);
      setDeleting(null);
      plans.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo eliminar el plan.');
      setDeleting(null);
    } finally {
      setPending(false);
    }
  }

  const items = plans.data?.items ?? [];
  const outdated = items.reduce((total, plan) => total + plan.tenants.outdated, 0);

  return (
    <>
      <div className="page-heading plans-heading">
        <div>
          <span className="eyebrow">CATÁLOGO</span>
          <h1>Planes</h1>
          <p>
            Capacidad de cada institución: servidores, disco, límites de uso de la app y respaldo. Cada
            institución conserva la versión del plan con la que se creó.
          </p>
        </div>
        {isAdmin && (
          <button className="button primary" onClick={() => setEditor({})}>
            <Icon name="plus" size={17} />
            Nuevo plan
          </button>
        )}
      </div>

      {notice && (
        <p role="status" className="alert info plans-notice">
          {notice}
          <button className="icon-button" aria-label="Cerrar aviso" onClick={() => setNotice('')}>
            ×
          </button>
        </p>
      )}
      {(error || plans.error) && (
        <p role="alert" className="alert error">
          {error || plans.error}
        </p>
      )}

      {plans.loading ? (
        <div className="empty-state">Cargando planes…</div>
      ) : !items.length ? (
        <div className="empty-state">
          <span className="empty-icon">
            <Icon name="layers" size={30} />
          </span>
          <h2>No hay planes</h2>
          <p>Crea un plan para poder registrar instituciones.</p>
        </div>
      ) : (
        <div className="plan-grid">
          {items.map((plan) => (
            <article key={plan.code} className="panel plan-tile">
              <header>
                <div>
                  <h2>{plan.name}</h2>
                  <code className="plan-code">{plan.code}</code>
                </div>
                <span className="badge" title={`Actualizado ${new Date(plan.updated_at).toLocaleString('es-BO')}`}>
                  v{plan.version}
                </span>
              </header>
              <p className="muted plan-description">{plan.description || 'Sin descripción.'}</p>

              <h3>Límites de la app</h3>
              <dl className="plan-facts">
                {LIMIT_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{number(plan.limits[key])}</dd>
                  </div>
                ))}
              </dl>

              <h3>Infraestructura</h3>
              <dl className="plan-facts">
                <div>
                  <dt>Frontend</dt>
                  <dd>{plan.sizing.frontend}</dd>
                </div>
                <div>
                  <dt>Backend</dt>
                  <dd>{plan.sizing.backend}</dd>
                </div>
                <div>
                  <dt>Base de datos</dt>
                  <dd>
                    {plan.sizing.db} · {plan.sizing.db_disk_gb} GB
                  </dd>
                </div>
                <div>
                  <dt>Respaldo</dt>
                  <dd>{backupLabel(plan.backup)}</dd>
                </div>
              </dl>

              <div className="plan-tile-footer">
                <span className="plan-usage">
                  <Icon name="building" size={16} />
                  {plan.tenants.total === 1 ? '1 institución' : `${plan.tenants.total} instituciones`}
                  {plan.tenants.outdated > 0 && (
                    <span className="plan-outdated" title="Se crearon con una versión anterior y la conservan">
                      {plan.tenants.outdated} en versión anterior
                    </span>
                  )}
                </span>
                {isAdmin && (
                  <span className="plan-actions">
                    <button className="button small" onClick={() => setEditor({ plan })}>
                      Editar
                    </button>
                    <button
                      className="button small"
                      disabled={plan.tenants.total > 0 || pending}
                      title={
                        plan.tenants.total > 0
                          ? 'No se puede eliminar un plan con instituciones'
                          : 'Eliminar plan'
                      }
                      onClick={() => setDeleting(plan)}
                    >
                      Eliminar
                    </button>
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="panel plans-rules">
        <h2>Cómo se aplican los cambios</h2>
        <ul>
          <li>
            <strong>Una institución nueva</strong> copia la versión vigente del plan al registrarse.
          </li>
          <li>
            <strong>Editar un plan</strong> crea una versión nueva. Las instituciones existentes no cambian: así
            una suspensión o reanudación no recrea sus servidores
            {outdated > 0 ? ` (hoy ${outdated} usan una versión anterior)` : ''}.
          </li>
          <li>
            <strong>Los límites</strong> los hace cumplir la app de cada institución: al superarlos responde con
            un aviso para solicitar un cambio de plan.
          </li>
        </ul>
      </section>

      {editor && (
        <PlanEditor
          plan={editor.plan}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setError('');
            setNotice(message);
            plans.reload();
          }}
        />
      )}

      {deleting && (
        <div className="plan-dialog-backdrop" role="presentation" onClick={() => setDeleting(null)}>
          <div
            className="plan-dialog panel narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-plan-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-plan-title">Eliminar plan {deleting.name}</h2>
            <p className="muted">
              Dejará de ofrecerse en el registro de instituciones. Solo se puede eliminar un plan que ninguna
              institución use ni haya usado.
            </p>
            <div className="form-actions">
              <button className="button" onClick={() => setDeleting(null)}>
                Cancelar
              </button>
              <button className="button danger" disabled={pending} onClick={() => void remove(deleting)}>
                {pending ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
