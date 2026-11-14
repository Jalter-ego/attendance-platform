import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useResource } from '../../../hooks/useResource';
import { plansService } from '../services/plans.service';
import {
  BACKUP_OPTIONS,
  INSTANCE_SIZES,
  LIMIT_FIELDS,
  backupValue,
  type CatalogPlan,
  type PlanDetail,
  type PlanInput,
  type PlanLimits,
} from '../types';

const CODE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const MAX_DISK_GB = 1000;

type Form = {
  code: string;
  name: string;
  description: string;
  frontend: string;
  backend: string;
  db: string;
  disk: string;
  backup: string;
} & Record<keyof PlanLimits, string>;

function toForm(plan?: CatalogPlan): Form {
  return {
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    frontend: plan?.sizing.frontend ?? 't3.micro',
    backend: plan?.sizing.backend ?? 't3.micro',
    db: plan?.sizing.db ?? 't3.micro',
    disk: String(plan?.sizing.db_disk_gb ?? 10),
    backup: plan ? backupValue(plan.backup) : 'weekly-28',
    max_students: plan?.limits.max_students?.toString() ?? '',
    max_teachers: plan?.limits.max_teachers?.toString() ?? '',
    max_courses: plan?.limits.max_courses?.toString() ?? '',
  };
}

function toInput(form: Form): PlanInput {
  const limits: PlanLimits = {};
  for (const { key } of LIMIT_FIELDS) if (form[key].trim()) limits[key] = Number(form[key]);
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    sizing: { frontend: form.frontend, backend: form.backend, db: form.db, db_disk_gb: Number(form.disk) },
    limits,
    backup: BACKUP_OPTIONS.find((option) => option.value === form.backup)!.backup,
  };
}

function validate(form: Form, creating: boolean) {
  const errors: Partial<Record<keyof Form, string>> = {};
  if (creating && !CODE.test(form.code))
    errors.code = '3–40 minúsculas, números o guiones; empieza con letra.';
  if (!form.name.trim()) errors.name = 'El nombre es obligatorio.';
  const disk = Number(form.disk);
  if (!Number.isInteger(disk) || disk < 10 || disk > MAX_DISK_GB)
    errors.disk = `Entero entre 10 y ${MAX_DISK_GB} GB.`;
  for (const { key } of LIMIT_FIELDS) {
    const value = form[key].trim();
    if (value && (!/^\d+$/.test(value) || Number(value) < 1))
      errors[key] = 'Entero mayor que 0, o vacío para no limitar.';
  }
  return errors;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Crear (sin `plan`) o editar un plan. Al editar, muestra qué tenants NO cambiarán. */
export function PlanEditor({
  plan,
  onClose,
  onSaved,
}: {
  plan?: CatalogPlan;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const creating = !plan;
  const [form, setForm] = useState<Form>(() => toForm(plan));
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof Form) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const code = plan?.code ?? '';
  const detailFetcher = useCallback(
    (signal: AbortSignal): Promise<PlanDetail | null> =>
      code ? plansService.detail(code, signal) : Promise.resolve(null),
    [code],
  );
  const detail = useResource<PlanDetail | null>(`plans:detail:${code}`, detailFetcher);
  const tenants = detail.data?.tenant_list ?? [];

  const errors = validate(form, creating);
  const input = useMemo(() => toInput(form), [form]);
  const changes = plan
    ? {
        any: !(['name', 'description', 'sizing', 'limits', 'backup'] as const).every((key) =>
          same(normalize(plan[key]), normalize(input[key])),
        ),
        infra:
          !same(normalize(plan.sizing), normalize(input.sizing)) ||
          !same(normalize(plan.limits), normalize(input.limits)) ||
          !same(normalize(plan.backup), normalize(input.backup)),
      }
    : { any: true, infra: false };
  const needsAck = !creating && changes.any && tenants.length > 0;
  const canSave = !Object.keys(errors).length && changes.any && (!needsAck || accepted) && !saving;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || (!creating && detail.loading)) return;
    setSaving(true);
    setError('');
    try {
      if (!plan) {
        const created = await plansService.create({ ...input, code: form.code });
        onSaved(`Plan ${created.name} creado. Ya aparece en el wizard de creación de tenants.`);
      } else {
        const result = await plansService.update(code, { ...input, version: plan.version });
        onSaved(
          !result.changed
            ? 'No había cambios que guardar.'
            : (result.warning ?? `Plan ${result.plan.name} guardado (versión ${result.plan.version}).`),
        );
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo guardar el plan.');
      setSaving(false);
    }
  }

  return (
    <div className="plan-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="plan-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-editor-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        noValidate
      >
        <h2 id="plan-editor-title">{plan ? `Editar plan ${plan.name}` : 'Nuevo plan'}</h2>
        <p className="muted">
          {plan
            ? `Versión actual: v${plan.version}. Guardar crea la v${plan.version + 1}.`
            : 'Los tamaños, el disco y el respaldo siguen las reglas del módulo de infraestructura.'}
        </p>

        <fieldset className="plan-form">
          <legend>Identidad</legend>
          {creating && (
            <Field label="Código" error={errors.code} help="Identificador fijo: no se puede cambiar después.">
              <input value={form.code} onChange={set('code')} placeholder="escuela-rural" autoFocus />
            </Field>
          )}
          <Field label="Nombre" error={errors.name}>
            <input value={form.name} onChange={set('name')} maxLength={100} autoFocus={!creating} />
          </Field>
          <Field label="Descripción" help="Se muestra en la tarjeta del wizard.">
            <input value={form.description} onChange={set('description')} maxLength={300} />
          </Field>
        </fieldset>

        <fieldset className="plan-form three">
          <legend>Límites de la app (vacío = sin límite)</legend>
          {LIMIT_FIELDS.map(({ key, label, help }) => (
            <Field key={key} label={label} error={errors[key]} help={help}>
              <input inputMode="numeric" value={form[key]} onChange={set(key)} placeholder="Sin límite" />
            </Field>
          ))}
        </fieldset>

        <fieldset className="plan-form four">
          <legend>Servidores y disco</legend>
          {(['frontend', 'backend', 'db'] as const).map((role) => (
            <Field key={role} label={role === 'db' ? 'Base de datos' : role === 'backend' ? 'Backend' : 'Frontend'}>
              <select value={form[role]} onChange={set(role)}>
                {INSTANCE_SIZES.map((size) => (
                  <option key={size}>{size}</option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="Disco de BD (GB)" error={errors.disk}>
            <input inputMode="numeric" value={form.disk} onChange={set('disk')} />
          </Field>
        </fieldset>

        <fieldset className="plan-form">
          <legend>Respaldo</legend>
          <Field label="Frecuencia y retención" help="Volcado a S3 y snapshot EBS programados (DLM).">
            <select value={form.backup} onChange={set('backup')}>
              {BACKUP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>

        {!creating && detail.loading && <p className="muted">Consultando qué instituciones usan el plan…</p>}
        {needsAck && plan && (
          <div className="plan-impact" role="status">
            <strong>
              {tenants.length} institución(es) usan este plan y <u>no cambiarán</u>.
            </strong>
            <p>
              Conservan la versión con la que se crearon: sus límites, servidores y respaldo siguen igual.
              La v{plan.version + 1} se aplica a las instituciones que se creen desde ahora.
              {changes.infra &&
                ' Llevar una institución existente a la versión nueva es un cambio de plan: puede redimensionar o recrear sus servidores.'}
            </p>
            <ul>
              {tenants.slice(0, 6).map((tenant) => (
                <li key={tenant.id}>
                  {tenant.name} · {tenant.tenant_id}/{tenant.env} · v{tenant.plan_version}
                </li>
              ))}
              {tenants.length > 6 && <li>y {tenants.length - 6} más…</li>}
            </ul>
            <label className="plan-ack">
              <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
              Entendido: las instituciones existentes no se modifican.
            </label>
          </div>
        )}
        {!creating && !changes.any && <p className="muted">Sin cambios todavía.</p>}
        {error && (
          <p role="alert" className="alert error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button primary" disabled={!canSave}>
            {saving ? 'Guardando…' : creating ? 'Crear plan' : 'Guardar versión nueva'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  error,
  help,
  children,
}: {
  label: string;
  error?: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="plan-field">
      {label}
      {children}
      {error ? <span className="field-error">{error}</span> : help && <span className="field-help">{help}</span>}
    </label>
  );
}

// Orden de claves estable para comparar objetos JSON.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  return value;
}
