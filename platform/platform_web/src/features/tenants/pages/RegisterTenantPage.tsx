import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/hooks/useAuth';
import { tenantsService } from '../services/tenants.service';
import type { Tenant } from '../types';
import { useResource } from '../../../hooks/useResource';
import { Icon } from '../../../components/Icon';

export function RegisterTenantPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fetchPlans = useCallback(
    (signal: AbortSignal) => tenantsService.plans(signal),
    [],
  );
  const plans = useResource('plans', fetchPlans);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (user?.role !== 'platform_admin')
    return <Navigate to="/tenants" replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setPending(true);
    try {
      const tenant = await tenantsService.register({
        name: String(form.get('name')).trim(),
        tenant_id: String(form.get('tenant_id')).trim(),
        contact_email: String(form.get('contact_email')).trim(),
        timezone: String(form.get('timezone')),
        env: form.get('env') as Tenant['env'],
        plan: form.get('plan') as Tenant['plan'],
        engine: form.get('engine') as Tenant['engine'],
      });
      navigate(`/tenants/${tenant.id}`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'No se pudo registrar la institución.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Link className="back-link" to="/tenants">
        <Icon name="back" size={16} />
        Instituciones
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">NUEVA INSTITUCIÓN</span>
          <h1>Un nuevo espacio</h1>
          <p>Registra la institución y su configuración inicial.</p>
        </div>
      </div>
      <form className="panel registration-form" onSubmit={submit}>
        <div className="section-title">
          <span className="section-number">01</span>
          <div>
            <h2>Datos de la institución</h2>
            <p>El identificador será permanente para este entorno.</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Nombre de la institución
            <input
              name="name"
              placeholder="Instituto San Marcos"
              required
              maxLength={150}
            />
          </label>
          <label>
            Identificador
            <input
              name="tenant_id"
              placeholder="san-marcos"
              pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
              title="Entre 3 y 40 letras minúsculas, números o guiones"
              required
              minLength={3}
              maxLength={40}
            />
          </label>
          <label>
            Correo del responsable
            <input
              name="contact_email"
              type="email"
              required
              placeholder="admin@institucion.edu"
              maxLength={255}
            />
          </label>
          <label>
            Zona horaria
            <input
              name="timezone"
              defaultValue="America/La_Paz"
              required
              maxLength={100}
            />
          </label>
        </div>
        <div className="section-title form-divider">
          <span className="section-number">02</span>
          <div>
            <h2>Configuración inicial</h2>
            <p>Selecciona el plan, entorno y motor.</p>
          </div>
        </div>
        <div className="form-grid three-columns">
          <label>
            Plan
            <select
              name="plan"
              required
              defaultValue="basic"
              disabled={!plans.data}
            >
              {plans.data?.items.map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Entorno
            <select name="env" defaultValue="test">
              <option value="test">Pruebas</option>
              <option value="prod">Producción</option>
            </select>
          </label>
          <label>
            Motor
            <select name="engine" defaultValue="terraform">
              <option value="terraform">Terraform</option>
              <option value="tofu">OpenTofu</option>
              <option value="pulumi">Pulumi</option>
              <option value="cloudformation">CloudFormation</option>
            </select>
          </label>
        </div>
        <p className="alert info">
          Este paso guarda el registro. El despliegue de servidores todavía no
          está habilitado.
        </p>
        {(error || plans.error) && (
          <p role="alert" className="alert error">
            {error || plans.error}
          </p>
        )}
        <div className="form-actions">
          <Link className="button" to="/tenants">
            Cancelar
          </Link>
          <button className="button primary" disabled={pending || !plans.data}>
            {pending ? 'Guardando…' : 'Registrar institución'}
            <Icon name="arrow" size={17} />
          </button>
        </div>
      </form>
    </>
  );
}
