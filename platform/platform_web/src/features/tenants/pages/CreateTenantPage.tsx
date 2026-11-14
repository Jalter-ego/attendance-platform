// Wizard "Crear tenant" (P2, RF-03/RF-07): Datos y plan → Configuración → Revisión.
// El panel puede registrar un borrador o crear el tenant y encolar el trabajo juntos.
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/hooks/useAuth';
import { tenantsService } from '../services/tenants.service';
import { engineNames } from '../types';
import type { Engine, Plan, Tenant } from '../types';
import { useResource } from '../../../hooks/useResource';
import { Icon } from '../../../components/Icon';
import './create-tenant.css';

type Draft = {
  name: string;
  tenant_id: string;
  contact_email: string;
  region: string;
  env: Tenant['env'];
  plan: Tenant['plan'];
  engine: Tenant['engine'];
  timezone: string;
  provision: boolean;
  simulate_failure: boolean;
};

const STEPS = ['Datos y plan', 'Configuración', 'Revisión'];
const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// La red base y las AMIs de Packer están en us-east-2 (docs/contratos-integracion.md).
const REGIONS = [{ code: 'us-east-2', label: 'EE. UU. Este (Ohio)' }];
const TIMEZONES = [
  'America/La_Paz',
  'America/Lima',
  'America/Bogota',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Mexico_City',
  'UTC',
];
// Respaldo si un plan no trae descripción (la edita P4 en la pantalla Planes).
const PLAN_COPY: Record<string, string> = {
  basic: 'Para instituciones pequeñas',
  standard: 'Para instituciones en crecimiento',
  advanced: 'Para alta demanda',
};
const ENGINE_COPY: Record<Tenant['engine'], string> = {
  terraform: 'Motor principal. Estado en S3 con bloqueo por tenant.',
  tofu: 'El mismo módulo de Terraform con el CLI de código abierto.',
  pulumi: 'El mismo stack escrito como programa.',
  cloudformation: 'Plantilla nativa de AWS, un stack por tenant.',
};

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function backupText(plan: Plan) {
  if (!plan.backup) return 'Sin respaldo programado';
  return `Respaldo ${plan.backup.schedule === 'daily' ? 'diario' : 'semanal'} · ${plan.backup.retention_days} días`;
}

function stepErrors(step: number, draft: Draft) {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (step === 0) {
    if (!draft.name.trim()) errors.name = 'Escribe el nombre de la institución.';
    if (!TENANT_ID.test(draft.tenant_id))
      errors.tenant_id = 'Usa 3–40 letras minúsculas, números o guiones (sin guion al inicio o al final).';
    if (!EMAIL.test(draft.contact_email.trim()))
      errors.contact_email = 'Escribe un correo válido.';
  }
  if (step === 1 && !draft.timezone) errors.timezone = 'Elige una zona horaria.';
  return errors;
}

export function CreateTenantPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fetchPlans = useCallback((signal: AbortSignal) => tenantsService.plans(signal), []);
  const fetchEngines = useCallback((signal: AbortSignal) => tenantsService.engines(signal), []);
  const plans = useResource('plans', fetchPlans);
  const engines = useResource('engines', fetchEngines);
  const [step, setStep] = useState(0);
  const [idTouched, setIdTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    name: '',
    tenant_id: '',
    contact_email: '',
    region: REGIONS[0].code,
    env: 'test',
    plan: '',
    engine: 'terraform',
    timezone: 'America/La_Paz',
    provision: true,
    simulate_failure: false,
  });
  if (user?.role !== 'platform_admin') return <Navigate to="/tenants" replace />;

  const planCode = draft.plan || plans.data?.items.find((item) => item.code === 'standard')?.code || plans.data?.items[0]?.code;
  const plan = plans.data?.items.find((item) => item.code === planCode);
  const engine: Engine | undefined = engines.data?.items.find((item) => item.code === draft.engine);
  const isLocal = engines.data?.mode === 'local';
  const engineReady = Boolean(engine?.available);
  const provisioning = draft.provision && engineReady;
  const errors = showErrors ? stepErrors(step, draft) : {};
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !plan || !engine) return;
    if (Object.keys(stepErrors(step, draft)).length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    setError('');
    setPending(true);
    try {
      const input = {
        name: draft.name.trim(),
        tenant_id: draft.tenant_id,
        contact_email: draft.contact_email.trim(),
        region: draft.region,
        env: draft.env,
        plan: plan.code,
        engine: engine.code,
        timezone: draft.timezone,
      };
      const tenant = provisioning
        ? (await tenantsService.provision(isLocal ? { ...input, simulate_failure: draft.simulate_failure } : input)).tenant
        : await tenantsService.register(input);
      navigate(`/tenants/${tenant.id}`);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'No se pudo registrar la institución.',
      );
      setPending(false);
    }
  }

  const field = (key: keyof Draft) =>
    errors[key] ? (
      <span className="field-error" id={`${key}-error`}>
        {errors[key]}
      </span>
    ) : null;

  return (
    <>
      <Link className="back-link" to="/tenants">
        <Icon name="back" size={16} />
        Instituciones
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TENANTS / CREAR TENANT</span>
          <h1>Crear tenant</h1>
          <p>Configura una nueva institución y prepara su entorno de registro de asistencia.</p>
        </div>
      </div>
      <ol className="wizard-steps" aria-label="Pasos para crear el tenant">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={index === step ? 'current' : index < step ? 'done' : ''}
            aria-current={index === step ? 'step' : undefined}
          >
            <span className="step-dot">{index < step ? <Icon name="check" size={13} /> : index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      <p className="wizard-counter">
        Paso {step + 1} de {STEPS.length}
      </p>
      <form className="wizard" onSubmit={submit} noValidate>
        <div className="panel wizard-main">
          {step === 0 && (
            <>
              <section>
                <h2>Datos de la institución</h2>
                <p className="muted">Identifica al tenant y configura su primer entorno.</p>
                <div className="form-grid">
                  <label>
                    Nombre de la institución *
                    <input
                      value={draft.name}
                      maxLength={150}
                      placeholder="Instituto San Marcos"
                      aria-invalid={Boolean(errors.name)}
                      aria-describedby="name-error"
                      onChange={(event) => {
                        const name = event.target.value;
                        setDraft((current) => ({
                          ...current,
                          name,
                          tenant_id: idTouched ? current.tenant_id : slugify(name),
                        }));
                      }}
                    />
                    {field('name')}
                  </label>
                  <label>
                    Identificador del tenant *
                    <input
                      value={draft.tenant_id}
                      maxLength={40}
                      placeholder="san-marcos"
                      aria-invalid={Boolean(errors.tenant_id)}
                      aria-describedby="tenant_id-error tenant_id-help"
                      onChange={(event) => {
                        setIdTouched(true);
                        set('tenant_id', event.target.value.toLowerCase());
                      }}
                    />
                    <span className="field-help" id="tenant_id-help">
                      Permanente: nombra los recursos en AWS y el estado del motor.
                    </span>
                    {field('tenant_id')}
                  </label>
                  <label>
                    Correo del administrador *
                    <input
                      type="email"
                      value={draft.contact_email}
                      maxLength={255}
                      placeholder="admin@institucion.edu"
                      aria-invalid={Boolean(errors.contact_email)}
                      aria-describedby="contact_email-error"
                      onChange={(event) => set('contact_email', event.target.value)}
                    />
                    {field('contact_email')}
                  </label>
                  <div className="form-grid two-inline">
                    <label>
                      Región de despliegue
                      <select value={draft.region} onChange={(event) => set('region', event.target.value)}>
                        {REGIONS.map((region) => (
                          <option key={region.code} value={region.code}>
                            {region.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Entorno
                      <select
                        value={draft.env}
                        onChange={(event) => set('env', event.target.value as Tenant['env'])}
                      >
                        <option value="test">Pruebas</option>
                        <option value="prod">Producción</option>
                      </select>
                    </label>
                  </div>
                </div>
              </section>
              <section className="wizard-section">
                <h2>Selecciona un plan</h2>
                <p className="muted">El plan define la capacidad y los límites iniciales del tenant.</p>
                {plans.error && <>
                  <p className="alert error" role="alert">{plans.error}</p>
                  <button type="button" className="button" onClick={plans.reload}>Recargar planes</button>
                </>}
                {plans.loading && <p className="muted" role="status">Cargando planes…</p>}
                {plans.data?.items.length === 0 && <p className="muted">Todavía no hay planes en el catálogo.</p>}
                <div className="plan-cards" role="radiogroup" aria-label="Plan">
                  {plans.data?.items.map((item) => (
                    <label key={item.code} className={`plan-card ${item.code === planCode ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="plan"
                        value={item.code}
                        checked={item.code === planCode}
                        onChange={() => set('plan', item.code)}
                      />
                      <span className="plan-card-head">
                        <strong>{item.name}</strong>
                        {item.code === planCode && <span className="badge">Seleccionado</span>}
                      </span>
                      <span className="muted">{item.description || PLAN_COPY[item.code] || ''}</span>
                      <ul>
                        <li>Hasta {item.limits.max_students?.toLocaleString('es-BO') ?? '∞'} estudiantes</li>
                        <li>
                          {item.limits.max_teachers ?? '∞'} docentes · {item.limits.max_courses ?? '∞'} cursos
                        </li>
                        <li>Base de datos: {item.sizing.db_disk_gb} GB</li>
                        <li>{backupText(item)}</li>
                      </ul>
                    </label>
                  ))}
                </div>
              </section>
              <section className="wizard-section">
                <h2>Motor de infraestructura</h2>
                <p className="muted">Elige la herramienta que aprovisionará los recursos de este tenant.</p>
                {engines.error && <>
                  <p className="alert error" role="alert">{engines.error}</p>
                  <button type="button" className="button" onClick={engines.reload}>Recargar motores</button>
                </>}
                {engines.loading && <p className="muted" role="status">Cargando motores…</p>}
                <div className="engine-options" role="radiogroup" aria-label="Motor de infraestructura">
                  {engines.data?.items.map((item) => (
                    <label key={item.code} className={`engine-option ${item.code === draft.engine ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="engine"
                        value={item.code}
                        checked={item.code === draft.engine}
                        onChange={() => set('engine', item.code)}
                      />
                      <span>
                        <strong>{item.label}</strong>
                        {isLocal && <span className="badge muted-badge">Simulado en local</span>}
                        {!item.available && <span className="badge muted-badge">Solo registro por ahora</span>}
                        <span className="muted">{ENGINE_COPY[item.code]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}

          {step === 1 && plan && (
            <>
              <section>
                <h2>Configuración</h2>
                <p className="muted">Ajustes de la instalación y recursos que asigna el plan {plan.name}.</p>
                <div className="form-grid">
                  <label>
                    Zona horaria de la institución
                    <select value={draft.timezone} onChange={(event) => set('timezone', event.target.value)}>
                      {TIMEZONES.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </select>
                    <span className="field-help">La usan Attendance y cloud-init en cada servidor.</span>
                  </label>
                </div>
              </section>
              <section className="wizard-section">
                <h2>Servidores del tenant</h2>
                <p className="muted">
                  {isLocal
                    ? 'El entorno local simula los tres servidores con los tamaños del plan.'
                    : 'Tres EC2 creadas desde las AMIs de Packer y configuradas por cloud-init y Ansible.'}
                </p>
                <table className="resource-table">
                  <thead>
                    <tr>
                      <th>Rol</th>
                      <th>Instancia</th>
                      <th>Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Frontend</td>
                      <td>{plan.sizing.frontend}</td>
                      <td>nginx con IP pública; reenvía /core/ a la API</td>
                    </tr>
                    <tr>
                      <td>Backend</td>
                      <td>{plan.sizing.backend}</td>
                      <td>API privada con los límites del plan</td>
                    </tr>
                    <tr>
                      <td>Base de datos</td>
                      <td>{plan.sizing.db}</td>
                      <td>PostgreSQL en disco EBS cifrado de {plan.sizing.db_disk_gb} GB</td>
                    </tr>
                  </tbody>
                </table>
              </section>
              <section className="wizard-section">
                <h2>Límites y respaldo</h2>
                <dl className="wizard-facts">
                  <div>
                    <dt>Estudiantes</dt>
                    <dd>{plan.limits.max_students ?? 'Sin límite'}</dd>
                  </div>
                  <div>
                    <dt>Docentes</dt>
                    <dd>{plan.limits.max_teachers ?? 'Sin límite'}</dd>
                  </div>
                  <div>
                    <dt>Cursos</dt>
                    <dd>{plan.limits.max_courses ?? 'Sin límite'}</dd>
                  </div>
                  <div>
                    <dt>Respaldo</dt>
                    <dd>{backupText(plan)}</dd>
                  </div>
                </dl>
              </section>
            </>
          )}

          {step === 2 && plan && (
            <>
              <section>
                <h2>Revisión</h2>
                <p className="muted">Confirma los datos antes de crear el tenant.</p>
                <dl className="wizard-facts">
                  <div>
                    <dt>Institución</dt>
                    <dd>{draft.name}</dd>
                  </div>
                  <div>
                    <dt>Identificador</dt>
                    <dd>
                      {draft.tenant_id} · {draft.env === 'test' ? 'Pruebas' : 'Producción'}
                    </dd>
                  </div>
                  <div>
                    <dt>Administrador</dt>
                    <dd>{draft.contact_email}</dd>
                  </div>
                  <div>
                    <dt>Plan</dt>
                    <dd>{plan.name}</dd>
                  </div>
                  <div>
                    <dt>Motor</dt>
                    <dd>{engineNames[draft.engine]}</dd>
                  </div>
                  <div>
                    <dt>Región y zona horaria</dt>
                    <dd>
                      {draft.region} · {draft.timezone}
                    </dd>
                  </div>
                </dl>
                <button type="button" className="text-link as-button" onClick={() => setStep(0)} disabled={pending}>
                  Editar datos
                </button>
              </section>
              <section className="wizard-section">
                <h2>{isLocal ? 'Qué se simulará en local' : 'Qué se creará en AWS'}</h2>
                {isLocal ? <ul className="create-list">
                  <li>Frontend {plan.sizing.frontend}, backend {plan.sizing.backend} y base de datos {plan.sizing.db}</li>
                  <li>Disco de datos de {plan.sizing.db_disk_gb} GB</li>
                  <li>Progreso, logs, versiones y URL de demostración en el detalle</li>
                </ul> : <ul className="create-list">
                  <li>
                    3 EC2 (frontend {plan.sizing.frontend}, backend {plan.sizing.backend}, base de datos{' '}
                    {plan.sizing.db}) desde las AMIs de Packer
                  </li>
                  <li>1 disco EBS cifrado de {plan.sizing.db_disk_gb} GB para PostgreSQL</li>
                  <li>3 grupos de seguridad propios: la base solo acepta al backend de este tenant</li>
                  <li>Perfiles IAM limitados a /tenants/{draft.tenant_id}/{draft.env}/ en SSM</li>
                  <li>3 secretos SecureString en SSM (contraseña de BD, JWT y administrador inicial)</li>
                  {(draft.engine === 'terraform' || draft.engine === 'tofu') && (
                    <li>
                      Estado propio en S3: tenants/{draft.tenant_id}/{draft.env}/terraform.tfstate
                    </li>
                  )}
                  {draft.engine === 'cloudformation' && (
                    <li>
                      Stack independiente para esta institución y entorno, con estado administrado por AWS.
                    </li>
                  )}
                </ul>}
                <label className={`provision-toggle ${engineReady ? '' : 'disabled'}`}>
                  <input
                    type="checkbox"
                    checked={provisioning}
                    disabled={!engineReady}
                    onChange={(event) => set('provision', event.target.checked)}
                  />
                  <span>
                    <strong>{isLocal ? 'Simular el aprovisionamiento al confirmar' : 'Crear la infraestructura al confirmar'}</strong>
                    <span className="muted">
                      {engineReady
                        ? 'Si lo desmarcas, el tenant se guarda como borrador y podrás aprovisionarlo desde el detalle.'
                        : engine?.message || `${engine?.label ?? 'Este motor'} permite registrar un borrador.`}
                    </span>
                  </span>
                </label>
                {isLocal && provisioning && <label className="provision-toggle fail-toggle">
                  <input
                    type="checkbox"
                    checked={draft.simulate_failure}
                    onChange={(event) => set('simulate_failure', event.target.checked)}
                  />
                  <span>
                    <strong>Simular un fallo para probar el reintento</strong>
                    <span className="muted">Podrás reintentar el trabajo desde el detalle del tenant.</span>
                  </span>
                </label>}
              </section>
            </>
          )}

          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
        </div>

        <aside className="panel wizard-summary" aria-label="Resumen del tenant">
          <h2>Resumen del tenant</h2>
          <p className="muted">
            {provisioning ? (isLocal ? 'Aprovisionamiento simulado.' : 'Se aprovisionará al confirmar.') : 'Registro como borrador.'}
          </p>
          <div className="summary-institution">
            <span className="eyebrow">INSTITUCIÓN</span>
            <strong>{draft.name || 'Sin nombre'}</strong>
            <span className="muted">{draft.tenant_id || 'identificador'}</span>
          </div>
          <div className="summary-row">
            <span>Plan seleccionado</span>
            <strong>{plan?.name ?? '—'}</strong>
          </div>
          <h3>Recursos incluidos</h3>
          <ul className="summary-list">
            <li>Frontend y API{plan ? ` (${plan.sizing.frontend} / ${plan.sizing.backend})` : ''}</li>
            <li>Base de datos aislada{plan ? ` (${plan.sizing.db_disk_gb} GB)` : ''}</li>
            <li>{plan ? backupText(plan) : 'Respaldo según plan'}</li>
            {!isLocal && <li>Monitoreo en Grafana</li>}
          </ul>
          <h3>Aislamiento y seguridad</h3>
          <p className="summary-safe">
            <Icon name="check" size={15} />
            Los datos de este tenant quedan separados de otras instituciones.
          </p>
          <div className="summary-row">
            <span>Entorno y región</span>
            <strong>
              {draft.env === 'test' ? 'Pruebas' : 'Producción'} · {draft.region}
            </strong>
          </div>
          <div className="summary-row">
            <span>Motor</span>
            <strong>{engineNames[draft.engine]}</strong>
          </div>
          <p className="alert warning">
            La creación puede tardar varios minutos. Podrás seguir el progreso desde el detalle del tenant.
          </p>
        </aside>

        <div className="wizard-footer">
          <span className="muted">Los recursos se crean según el plan seleccionado.</span>
          <div>
            {step === 0 ? (
              <Link className="button" to="/tenants">
                Cancelar
              </Link>
            ) : (
              <button type="button" className="button" onClick={() => setStep(step - 1)} disabled={pending}>
                Atrás
              </button>
            )}
            <button className="button primary" disabled={pending || !plan || !engine}>
              {step < STEPS.length - 1
                ? 'Continuar'
                : pending
                  ? 'Creando…'
                  : provisioning
                    ? 'Crear tenant'
                    : 'Registrar tenant'}
              <Icon name="arrow" size={17} />
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
