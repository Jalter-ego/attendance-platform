import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useResource } from '../../hooks/useResource';
import { api, post } from '../../lib/api';
import type { Tenant } from './types';

type Admin = { id: string; name: string; email: string; active: boolean };
type AdminAction = { kind: 'create' } | { kind: 'reset' | 'toggle'; admin: Admin };

export function TenantAdminPanel({ tenant }: { tenant: Tenant }) {
  const endpoint = `/tenants/${encodeURIComponent(tenant.id)}/admins`;
  const load = useCallback((signal: AbortSignal) => api<{ items: Admin[] }>(endpoint, { signal }), [endpoint]);
  const admins = useResource(endpoint, load);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const editable = !['deleting', 'deleted'].includes(tenant.status);
  function select(next: AdminAction | null) {
    setAction(next);
    setError('');
    setNotice('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || !editable) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      if (action.kind === 'create') {
        await post(endpoint, { name: String(data.get('name')).trim(), email: String(data.get('email')).trim(), password: data.get('password') });
      } else {
        const payload = action.kind === 'reset' ? { password: data.get('password') } : { active: !action.admin.active };
        await api(`${endpoint}/${encodeURIComponent(action.admin.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }
      admins.reload();
      setAction(null);
      setNotice('Acceso actualizado.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo actualizar el acceso.');
    } finally {
      setPending(false);
    }
  }

  return <section className="panel p6-panel">
    <div className="panel-heading">
      <h2>Administradores del tenant</h2>
      {editable && <button className="button small" type="button" disabled={pending} onClick={() => select({ kind: 'create' })}>Agregar administrador</button>}
    </div>
    <p className="muted">Estas cuentas pueden consultar esta institución y sus operaciones.</p>
    {(error || admins.error) && <p role="alert" className="alert error">{error || admins.error}</p>}
    {notice && <p role="status">{notice}</p>}
    {admins.loading ? <p>Cargando accesos…</p> : admins.data?.items.length === 0 && <p>Esta institución todavía no tiene administradores.</p>}
    <ul className="p6-list">{admins.data?.items.map((admin) => <li key={admin.id}>
      <div><strong>{admin.name}</strong><p>{admin.email} · {admin.active ? 'Activo' : 'Desactivado'}</p></div>
      {editable && <div className="p6-actions">
        <button type="button" className="button small" disabled={pending} onClick={() => select({ kind: 'reset', admin })}>Cambiar contraseña</button>
        <button type="button" className="button small" disabled={pending} onClick={() => select({ kind: 'toggle', admin })}>{admin.active ? 'Desactivar' : 'Reactivar'}</button>
      </div>}
    </li>)}</ul>
    {action && editable && <form className="p6-action-form" key={action.kind === 'create' ? 'create' : `${action.kind}:${action.admin.id}`} onSubmit={submit}>
      <h3>{action.kind === 'create' ? 'Nueva cuenta' : action.admin.email}</h3>
      {action.kind === 'create' && <div className="form-grid">
        <label>Nombre<input name="name" required maxLength={150} /></label>
        <label>Correo electrónico<input name="email" type="email" required maxLength={255} /></label>
      </div>}
      {action.kind !== 'toggle' ? <label>{action.kind === 'create' ? 'Contraseña inicial' : 'Nueva contraseña'}
        <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
      </label> : <p>{action.admin.active ? 'Se cerrarán las sesiones de esta cuenta.' : 'La cuenta podrá volver a iniciar sesión.'}</p>}
      <div className="p6-actions">
        <button type="button" className="button" disabled={pending} onClick={() => select(null)}>Cancelar</button>
        <button className="button primary" disabled={pending}>{pending ? 'Guardando…' : action.kind === 'toggle' ? 'Confirmar' : 'Guardar acceso'}</button>
      </div>
    </form>}
  </section>;
}

export function TenantSecurity({ id }: { id: string }) {
  type Scan = { id: string; scanner: string; status: string; findings: unknown; created_at: string; target?: string; finding_count?: number };
  const statusLabels: Record<string, string> = { clean: 'Sin hallazgos', findings: 'Con hallazgos', error: 'Error de ejecución' };
  const load = useCallback((signal: AbortSignal) => api<{ scans: Scan[] }>(`/tenants/${encodeURIComponent(id)}/security`, { signal }), [id]);
  const scans = useResource(`security:${id}`, load, 5000);
  return <section className="panel p6-panel">
    <div className="panel-heading"><h2>Seguridad</h2></div>
    {scans.error && <p role="alert" className="alert error">{scans.error}</p>}
    {scans.loading && <p>Cargando escaneos…</p>}
    {scans.data?.scans.length === 0 && <p>Todavía no hay escaneos registrados.</p>}
    <ul className="p6-list">{scans.data?.scans.map((scan) => <li key={scan.id}>
      <div><strong>{scan.scanner}</strong><p>{statusLabels[scan.status] ?? scan.status} · {new Date(scan.created_at).toLocaleString('es-BO')}</p>
        {scan.target && <p>{scan.target}</p>}
        {scan.status === 'findings' && scan.finding_count != null && <p>Hallazgos totales: {scan.finding_count}</p>}
        {Array.isArray(scan.findings) && scan.findings.length > 0 && <details><summary>Ver hallazgos</summary>
          <ul>{scan.findings.filter((item): item is string => typeof item === 'string').map((item, index) => <li key={index}>{item}</li>)}</ul>
        </details>}
      </div>
    </li>)}</ul>
  </section>;
}
