import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon } from '../../../components/Icon';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (loading) return <div className="screen-state">Cargando plataforma…</div>;
  if (user) return <Navigate to="/tenants" replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError('');
    setPending(true);
    try {
      await login(String(values.get('email')), String(values.get('password')));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'No se pudo iniciar sesión.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <span>
            attendance<small>CONTROL CENTER</small>
          </span>
        </div>
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
        <form className="login-form" onSubmit={submit}>
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
              name="email"
              type="email"
              autoComplete="username"
              placeholder="nombre@institucion.edu"
              required
              maxLength={255}
            />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Tu contraseña"
              required
              maxLength={128}
            />
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
