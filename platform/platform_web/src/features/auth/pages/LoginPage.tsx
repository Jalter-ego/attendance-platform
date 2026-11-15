import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Icon } from '../../../components/Icon';
import './login.css';

type LoginFields = { email: string; password: string };

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [error, setError] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const fieldId = useId();
  const emailId = `${fieldId}-email`;
  const passwordId = `${fieldId}-password`;
  const {
    register,
    handleSubmit,
    formState: { isSubmitting: pending, errors },
  } = useForm<LoginFields>({ defaultValues: { email: '', password: '' } });

  if (loading) return <div className="screen-state" role="status">Cargando plataforma…</div>;
  if (user) return <Navigate to="/tenants" replace />;

  async function submit({ email, password }: LoginFields) {
    setError('');
    try {
      await login(email.trim(), password);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo iniciar sesión.');
    }
  }

  return (
    <div className="platform-login">
      <div className="platform-login-decoration" aria-hidden="true">
        <span className="platform-login-artwork"><Icon name="grid" size={600} /></span>
        <span className="platform-login-circle" />
        <span className="platform-login-orbit" />
      </div>

      <header className="platform-login-header">
        <Link className="platform-login-brand" to="/" aria-label="Attendance, inicio">
          <Icon name="grid" size={27} />
          <span>Attendance<span>.</span><small>Control Center</small></span>
        </Link>
        <Link className="platform-login-back" to="/">
          <Icon name="back" size={16} />Volver al inicio
        </Link>
      </header>

      <main className="platform-login-main">
        <div className="platform-login-grid">
          <section className="platform-login-intro" aria-label="Bienvenida">
            <p className="platform-login-kicker">Tu espacio de gestión</p>
            <p className="platform-login-welcome">Bienvenido a<br /><span>tu plataforma.</span></p>
            <p className="platform-login-description">
              Continúa con la gestión de tus instituciones y sus servicios desde un solo lugar.
            </p>
            <div className="platform-login-signature">
              <span aria-hidden="true" />Cada institución, su propio espacio.
            </div>
          </section>

          <section className="platform-login-panel" aria-labelledby="platform-login-title">
            <div className="platform-login-heading">
              <span>Acceso a Attendance</span>
              <h1 id="platform-login-title">Inicia sesión</h1>
              <p>Ingresa con tu cuenta para continuar.</p>
            </div>

            <form className="platform-login-form" onSubmit={handleSubmit(submit)} noValidate aria-busy={pending}>
              {error && <p role="alert" className="platform-login-feedback">{error}</p>}

              <div className="platform-login-field">
                <label htmlFor={emailId}>Correo electrónico</label>
                <div className={`platform-login-input${errors.email ? ' is-invalid' : ''}`}>
                  <Icon name="mail" size={18} />
                  <input
                    {...register('email', {
                      required: 'Ingresa tu correo.',
                      pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Ingresa un correo válido.' },
                    })}
                    id={emailId}
                    type="email"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="nombre@institucion.edu"
                    required
                    maxLength={255}
                    disabled={pending}
                    aria-invalid={Boolean(errors.email)}
                    aria-describedby={errors.email ? `${emailId}-error` : undefined}
                  />
                </div>
                {errors.email && <small id={`${emailId}-error`} role="alert">{errors.email.message}</small>}
              </div>

              <div className="platform-login-field">
                <label htmlFor={passwordId}>Contraseña</label>
                <div className={`platform-login-input${errors.password ? ' is-invalid' : ''}`}>
                  <Icon name="lock" size={18} />
                  <input
                    {...register('password', { required: 'Ingresa tu contraseña.' })}
                    id={passwordId}
                    type={passwordVisible ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Ingresa tu contraseña"
                    required
                    maxLength={128}
                    disabled={pending}
                    aria-invalid={Boolean(errors.password)}
                    aria-describedby={errors.password ? `${passwordId}-error` : undefined}
                  />
                  <button
                    className="platform-login-password-toggle"
                    type="button"
                    onClick={() => setPasswordVisible((visible) => !visible)}
                    aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    aria-pressed={passwordVisible}
                    aria-controls={passwordId}
                    disabled={pending}
                  >
                    <Icon name={passwordVisible ? 'eyeOff' : 'eye'} size={18} />
                  </button>
                </div>
                {errors.password && <small id={`${passwordId}-error`} role="alert">{errors.password.message}</small>}
              </div>

              <button className="platform-login-submit" type="submit" disabled={pending}>
                {pending ? 'Ingresando…' : 'Ingresar a la plataforma'}<Icon name="arrow" size={18} />
              </button>
            </form>

            <p className="platform-login-help">Si necesitas acceso, contacta al responsable de la plataforma.</p>
          </section>
        </div>
      </main>
    </div>
  );
}
