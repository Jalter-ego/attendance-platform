import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useResource } from '../../hooks/useResource';
import { useAuth } from '../auth/hooks/useAuth';
import { tenantsService } from '../tenants/services/tenants.service';
import classroom from './empty-classroom.webp';
import './landing.css';

const roles = [
  ['Administrador de institución', 'Organiza usuarios y cursos.'],
  ['Docente', 'Registra la asistencia de sus cursos.'],
  ['Estudiante', 'Consulta el historial de su asistencia.'],
];

const capabilities = [
  {
    number: '01',
    icon: 'building',
    title: 'Un espacio para cada institución',
    description: 'Organiza sus accesos y configuración. Cada institución cuenta con su propio entorno de asistencia.',
  },
  {
    number: '02',
    icon: 'activity',
    title: 'Seguimiento de principio a fin',
    description: 'Consulta la puesta en marcha, las operaciones y el estado de los servicios sin perder el contexto.',
  },
  {
    number: '03',
    icon: 'archive',
    title: 'Los respaldos, a mano',
    description: 'Encuentra las copias de seguridad de cada institución y gestiona su recuperación desde la plataforma.',
  },
] as const;

const examples = [
  { name: 'Colegio Valle Verde', initials: 'VV', plan: 'Básico', environment: 'Pruebas' },
  { name: 'Instituto San Marcos', initials: 'SM', plan: 'Estándar', environment: 'Producción' },
  { name: 'Unidad Educativa Horizonte', initials: 'UH', plan: 'Avanzado', environment: 'Producción' },
];

export function LandingPage() {
  const { user } = useAuth();
  const route = user ? '/tenants' : '/login';
  const action = user ? 'Abrir panel' : 'Ingresar al panel';

  return (
    <div className="platform-landing">
      <a className="landing-skip" href="#contenido">Ir al contenido</a>
      <header className="landing-header">
        <div className="landing-container landing-header-inner">
          <Link className="landing-brand" to="/" aria-label="Attendance, inicio">
            <span className="landing-brand-icon"><Icon name="grid" size={27} /></span>
            <span className="landing-brand-name">Attendance<span>.</span><small>Control Center</small></span>
          </Link>
          <nav className="landing-nav" aria-label="Navegación pública">
            <a href="#plataforma">La plataforma</a>
            <a href="#ejemplos">Instituciones</a>
          </nav>
          <Link className="landing-header-action" to={route}>
            {user ? 'Abrir panel' : 'Ingresar'}<Icon name="arrow" size={16} />
          </Link>
        </div>
      </header>

      <main id="contenido" tabIndex={-1}>
        <section className="landing-container landing-hero" id="inicio" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-kicker">Gestión de instituciones educativas</p>
            <h1 id="landing-title">Cada institución,<br /><span>su propio espacio.</span></h1>
            <p className="landing-introduction">
              Organiza tus instituciones, acompaña su puesta en marcha y consulta sus servicios desde un mismo lugar.
            </p>
            <div className="landing-hero-actions">
              <Link className="landing-primary" to={route}>{action}<Icon name="arrow" size={18} /></Link>
              <a className="landing-secondary" href="#plataforma">Conocer la plataforma<Icon name="arrow" size={16} /></a>
            </div>
            <p className="landing-access-note">Acceso para responsables de la plataforma.</p>
          </div>

          <figure className="landing-photograph">
            <div className="landing-photo-frame">
              <span className="landing-photo-orbit" aria-hidden="true" />
              <img src={classroom} alt="Aula vacía con escritorios de madera, una pizarra verde y luz natural." width={1536} height={1024} fetchPriority="high" />
            </div>
            <figcaption>Control de asistencia para instituciones educativas.</figcaption>
          </figure>
        </section>

        <section className="landing-platform" id="plataforma" aria-labelledby="platform-title">
          <div className="landing-container landing-section-grid">
            <div className="landing-section-intro">
              <p className="landing-kicker">La plataforma</p>
              <h2 id="platform-title">Menos pasos entre<br />tú y tus instituciones.</h2>
              <p>Una vista común para el trabajo de cada día, con la información de cada institución en su lugar.</p>
            </div>
            <ol className="landing-capabilities">
              {capabilities.map((item) => (
                <li key={item.number}>
                  <span className="landing-step-number" aria-hidden="true">{item.number}</span>
                  <div><h3>{item.title}</h3><p>{item.description}</p></div>
                  <span className="landing-capability-icon"><Icon name={item.icon} size={21} /></span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="landing-container landing-examples landing-section-grid" id="ejemplos" aria-labelledby="examples-title">
          <div className="landing-section-intro">
            <p className="landing-kicker">Instituciones de ejemplo</p>
            <h2 id="examples-title">Distintos entornos.<br />La misma organización.</h2>
            <p>Una muestra de cómo se presentan las instituciones, sus planes y el entorno en el que trabajan.</p>
            <span className="landing-example-note">Datos ilustrativos de la plataforma.</span>
          </div>
          <div className="landing-institutions" tabIndex={0} role="region" aria-label="Instituciones de ejemplo">
            <table>
              <caption className="sr-only">Ejemplos ilustrativos de instituciones, planes y entornos.</caption>
              <thead><tr><th scope="col">Institución</th><th scope="col">Plan</th><th scope="col">Entorno</th></tr></thead>
              <tbody>
                {examples.map((example) => (
                  <tr key={example.name}>
                    <td><div className="landing-institution"><span className="landing-initials" aria-hidden="true">{example.initials}</span><span>{example.name}</span></div></td>
                    <td className="landing-institution-plan"><span className="landing-plan-label">Plan </span>{example.plan}</td>
                    <td className="landing-institution-environment"><span className={`landing-environment${example.environment === 'Pruebas' ? ' is-test' : ''}`}>{example.environment}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div><span className="landing-footer-name">Attendance<span>.</span></span><p>Una plataforma para todas tus instituciones.</p></div>
          <Link to={route}>{action}<Icon name="arrow" size={17} /></Link>
        </div>
      </footer>
    </div>
  );
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
