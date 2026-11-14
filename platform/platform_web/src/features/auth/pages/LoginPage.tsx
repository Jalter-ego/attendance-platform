import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon } from '../../../components/Icon';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { isSubmitting: pending, errors } } = useForm<{ email: string; password: string }>({
    defaultValues: { email: '', password: '' },
  });
  if (loading) return <div className="screen-state">Cargando plataforma…</div>;
  if (user) return <Navigate to="/tenants" replace />;
  async function submit({ email, password }: { email: string; password: string }) {
    setError('');
    try {
      await login(email.trim(), password);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'No se pudo iniciar sesión.',
      );
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <span>
            attendance<small>CONTROL CENTER</small>
          </span>
        </Link>
        <div className="login-message">
          <span className="eyebrow">
            UN SOLO LUGAR. TODAS TUS INSTITUCIONES.
          </span>
          <h1>
            Tu plataforma,
            <br />
            bajo control.
          </h1>
          <p>
            Administra tus instituciones y sigue cada operación, de principio a
            fin.
          </p>
          <div className="orbit-card">
            <Icon name="building" size={32} />
            <div>
              <strong>Cada institución, su propio espacio</strong>
              <span>
                Una administración central. Instalaciones independientes.
              </span>
            </div>
            <span className="orbit-check">
              <Icon name="check" />
            </span>
          </div>
        </div>
        <small className="login-footnote">
          Attendance · Plataforma de administración
        </small>
      </section>
      <section className="login-form-area">
        <form className="login-form" onSubmit={handleSubmit(submit)} noValidate>
          <Link className="back-link" to="/"><Icon name="back" size={16} />Volver al inicio</Link>
          <span className="eyebrow">BIENVENIDO DE NUEVO</span>
          <h2>Inicia sesión</h2>
          <p>Ingresa con tu cuenta de la plataforma.</p>
          {error && (
            <div role="alert" className="alert error">
              {error}
            </div>
          )}
          <label>
            Correo electrónico
            <input
              {...register('email', { required: 'Ingresa tu correo.', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Ingresa un correo válido.' } })}
              type="email"
              autoComplete="username"
              placeholder="nombre@institucion.edu"
              required
              maxLength={255}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
            />
            {errors.email && <small id="login-email-error" role="alert">{errors.email.message}</small>}
          </label>
          <label>
            Contraseña
            <input
              {...register('password', { required: 'Ingresa tu contraseña.' })}
              type="password"
              autoComplete="current-password"
              placeholder="Tu contraseña"
              required
              maxLength={128}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
            />
            {errors.password && <small id="login-password-error" role="alert">{errors.password.message}</small>}
          </label>
          <button className="button primary full-width" disabled={pending}>
            {pending ? 'Ingresando…' : 'Ingresar a la plataforma'}
            <Icon name="arrow" size={18} />
          </button>
          <p className="login-help">
            El acceso es administrado por el responsable de la plataforma.
          </p>
        </form>
      </section>
    </div>
  );
}
