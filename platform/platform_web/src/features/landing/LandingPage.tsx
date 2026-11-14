import { Link, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useResource } from '../../hooks/useResource';
import { useAuth } from '../auth/hooks/useAuth';
import { tenantsService } from '../tenants/services/tenants.service';
import { useCallback } from 'react';
import classroom from './classroom.webp';

const roles = [
  ['Administrador de institución', 'Organiza usuarios y cursos.'],
  ['Docente', 'Registra la asistencia de sus cursos.'],
  ['Estudiante', 'Consulta el historial de su asistencia.'],
];

export function LandingPage() {
  const { user } = useAuth();
  const route = user ? '/tenants' : '/login';
  return <div className="p6-landing">
    <header><div className="p6-landing-container p6-landing-header">
      <Link className="brand" to="/"><span className="brand-mark"><Icon name="grid" /></span><span>attendance<small>CONTROL CENTER</small></span></Link>
      <nav aria-label="Navegación pública"><a href="#ejemplos">Ejemplos</a><a href="#plataforma">La plataforma</a></nav>
      <Link className="button primary" to={route}>{user ? 'Abrir panel' : 'Inicia sesión'} <Icon name="arrow" size={16} /></Link>
    </div></header>
    <main className="p6-landing-container">
      <section className="p6-public-hero">
        <div><h1>Asistencia escolar, institución por institución.</h1>
          <p>Administra los entornos de tus instituciones, sigue cada despliegue y consulta el estado de sus servicios desde un solo panel.</p>
          <Link className="button primary" to={route}>{user ? 'Abrir panel' : 'Inicia sesión'} <Icon name="arrow" size={16} /></Link>
        </div>
        <img src={classroom} alt="Estudiantes y docente en un aula" width={640} height={480} />
      </section>
      <section id="ejemplos" className="p6-public-section">
        <h2>Instituciones de ejemplo</h2><p>Estos ejemplos muestran cómo se organizan los entornos y sus planes.</p>
        <div className="p6-public-grid">
          {[
            ['Colegio Valle Verde', 'Básico', 'Pruebas'],
            ['Instituto San Marcos', 'Estándar', 'Producción'],
            ['Unidad Educativa Horizonte', 'Avanzado', 'Producción'],
          ].map(([name, plan, env]) => <article className="panel p6-panel" key={name}>
            <Icon name="building" /><h3>{name}</h3><p>{plan} · {env}</p>
          </article>)}
        </div>
      </section>
      <section id="plataforma" className="p6-public-section">
        <h2>La plataforma</h2><p>Cada institución tiene un entorno de asistencia y el operador administra sus despliegues, respaldos y accesos.</p>
        <div className="p6-public-grid">{roles.map(([title, text]) => <article className="panel p6-panel" key={title}><h3>{title}</h3><p>{text}</p></article>)}</div>
      </section>
    </main>
    <footer><div className="p6-landing-container">Attendance Control Center <Link to={route}>{user ? 'Abrir panel' : 'Inicia sesión'}</Link></div></footer>
  </div>;
}

export function DemoTenantPage() {
  const { id = '' } = useParams();
  const { mode } = useAuth();
  const load = useCallback((signal: AbortSignal) => tenantsService.detail(id, signal), [id]);
  const tenant = useResource(`demo:${id}`, load);
  return <>
    <Link className="back-link" to={`/tenants/${id}`}>Volver a la institución</Link>
    <div className="page-heading"><div><h1>Aplicación de asistencia</h1><p>{tenant.data?.name}</p></div></div>
    {tenant.error && <p role="alert" className="alert error">{tenant.error}</p>}
    {tenant.loading && <p>Cargando institución…</p>}
    {tenant.data && mode === 'local' && <><p>Entorno simulado de asistencia.</p>
      <div className="p6-public-grid">{roles.map(([title, text]) => <article className="panel p6-panel" key={title}><h2>{title}</h2><p>{text}</p></article>)}</div>
    </>}
  </>;
}
