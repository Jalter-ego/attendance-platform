import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { api, post } from '../../lib/api';
import { useResource } from '../../hooks/useResource';
import { operationsService } from '../operations/services/operations.service';
import type { Operation } from '../operations/types';
import type { TenantDetail, Plan } from './types';

export type TenantAction = 'suspend' | 'resume' | 'upgrade' | 'plan-change' | 'delete';
const labels = { suspend: 'Suspender', resume: 'Reanudar', upgrade: 'Actualizar', 'plan-change': 'Cambiar plan', delete: 'Eliminar' };
type Preview = NonNullable<Operation['result']>;

export function TenantActions({ tenant, supported, busy, onQueued }: { tenant: TenantDetail; supported: string[]; busy: boolean; onQueued: (item: Operation) => void }) {
  const [action, setAction] = useState<TenantAction | null>(null);
  const status = tenant.status;
  const stateActions: TenantAction[] = status === 'ready' ? ['suspend', 'upgrade', 'plan-change', 'delete']
    : status === 'suspended' ? ['resume', 'delete']
      : ['draft', 'failed'].includes(status) ? ['delete'] : [];
  const actions = stateActions.filter((kind) => supported.includes(kind) || (status === 'draft' && kind === 'delete'));
  if (!actions.length) return null;
  return <section className="panel p6-panel">
    <div className="panel-heading"><h2>Acciones del tenant</h2></div>
    <div className="p6-actions">
      {actions.map((kind) => <button type="button" className={`button small ${kind === 'delete' ? 'p6-danger' : ''}`} key={kind}
        disabled={busy} onClick={() => setAction(kind)}>{labels[kind]}</button>)}
    </div>
    {action && <ActionForm key={action} action={action} tenant={tenant} onDismiss={() => setAction(null)} onQueued={onQueued} />}
  </section>;
}

function ActionForm({ action, tenant, onDismiss, onQueued }: {
  action: TenantAction; tenant: TenantDetail; onDismiss: () => void; onQueued: (item: Operation) => void;
}) {
  const [queuedPreview, setQueuedPreview] = useState<Operation | null>(null);
  const [plan, setPlan] = useState('');
  const [scope, setScope] = useState('app');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/tenants/${encodeURIComponent(tenant.id)}/operations`;
  const usesPreview = action === 'delete' || action === 'plan-change';
  const catalogFetcher = useCallback((signal: AbortSignal) => action === 'plan-change' ? api<{items: Plan[]}>('/plans', { signal }) : Promise.resolve({ items: [] }), [action]);
  const catalog = useResource(`action-plans:${action}`, catalogFetcher);
  const previewFetcher = useCallback((signal: AbortSignal) =>
    queuedPreview ? operationsService.get(queuedPreview.id, signal) : Promise.resolve(null), [queuedPreview]);
  const previewState = useResource(`preview:${queuedPreview?.id ?? ''}`, previewFetcher, queuedPreview ? 800 : 0);
  const preview: Preview | undefined = previewState.data?.status === 'succeeded' ? previewState.data.result ?? undefined : undefined;
  const previewFailed = previewState.data && ['failed', 'cancelled'].includes(previewState.data.status);
  const waiting = Boolean(queuedPreview && !preview && !previewFailed && !previewState.error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      if (usesPreview && !preview) {
        const type = action === 'delete' ? 'preview-delete' : 'preview-plan';
        const item = await post<Operation>(endpoint, action === 'delete' ? { type } : { type, plan });
        setQueuedPreview(item);
        onQueued(item);
        return;
      }
      let body: Record<string, unknown> = { type: action };
      if (action === 'delete') body = { type: action, confirm: true, preview_id: queuedPreview?.id };
      if (action === 'plan-change') body = { type: action, plan, preview_id: queuedPreview?.id };
      if (action === 'upgrade') body = {
        type: action, scope, version: String(values.get('version') || '').trim(),
        ...(scope === 'app' ? { component: values.get('component') } : {}),
      };
      onQueued(await post<Operation>(endpoint, body));
      onDismiss();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'La operación no pudo iniciarse.');
      if (preview) setQueuedPreview(null);
    } finally {
      setPending(false);
    }
  }

  return <form className="p6-action-form" onSubmit={submit}>
    <h3>{labels[action]}</h3>
    {action === 'plan-change' && <label>Plan de destino
      <select value={plan} required disabled={waiting || pending} onChange={(event) => { setPlan(event.target.value); setQueuedPreview(null); }}>
        <option value="">Seleccionar</option>
        {catalog.data?.items.filter((item) => item.code !== tenant.plan || item.version !== tenant.plan_snapshot?.version
          || item.sizing.db_disk_gb !== tenant.plan_snapshot?.sizing.db_disk_gb).map((item) =>
          <option key={item.code} value={item.code}>{item.name}{item.code === tenant.plan ? ' · Aplicar versión actual' : ''}</option>)}
      </select>
    </label>}
    {action === 'upgrade' && <div className="form-grid">
      <label>Alcance<select value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="app">Aplicación</option><option value="infra">Infraestructura</option>
      </select></label>
      {scope === 'app' && <label>Componente<select name="component"><option value="backend">Backend</option><option value="frontend">Frontend</option></select></label>}
      <label>Versión<input name="version" required maxLength={100} /></label>
    </div>}
    {waiting && <p role="status">Calculando la vista previa…</p>}
    {preview && <div className="p6-preview">
      <strong>{preview.summary}</strong>
      {preview.downtime && <p>Puede haber una interrupción del servicio.</p>}
      <ul>{preview.changes?.map((change, index) => <li key={index}>{change}</li>)}</ul>
      {action === 'delete' && <label className="p6-checkbox"><input type="checkbox" required />Confirmo la eliminación de {tenant.name}</label>}
    </div>}
    {(error || catalog.error || previewState.error || previewFailed) && <p role="alert" className="alert error">
      {error || catalog.error || previewState.error || previewState.data?.error_message || 'La vista previa no se completó.'}
    </p>}
    <div className="p6-actions">
      <button type="button" className="button" disabled={pending} onClick={onDismiss}>Volver</button>
      <button className={`button primary ${action === 'delete' && preview ? 'p6-danger' : ''}`} disabled={pending || waiting}>
        {pending ? 'Enviando…' : usesPreview && !preview ? 'Ver vista previa' : action === 'plan-change' ? 'Confirmar cambio' : labels[action]}
      </button>
    </div>
  </form>;
}
