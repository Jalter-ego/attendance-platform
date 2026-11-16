import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../features/auth/hooks/useAuth';
import { Icon } from './Icon';
import './PlatformLayout.css';

const navigation = [
  { to: '/inicio', label: 'Inicio', icon: 'grid', adminOnly: false },
  { to: '/tenants', label: 'Instituciones', icon: 'building', adminOnly: false },
  { to: '/backups', label: 'Respaldos', icon: 'archive', adminOnly: false },
  { to: '/plans', label: 'Planes', icon: 'layers', adminOnly: true },
  { to: '/monitoring', label: 'Monitoreo', icon: 'activity', adminOnly: true },
  { to: '/audit', label: 'Auditoría', icon: 'history', adminOnly: true },
] as const;

export function PlatformLayout() {
  const { user, mode, logout } = useAuth();
  const { pathname } = useLocation();
  const [error, setError] = useState('');
  const currentSection = navigation.find((item) => pathname.startsWith(item.to))?.label
    ?? (pathname.startsWith('/demo') ? 'Vista de institución' : 'Instituciones');

  return (
    <div className="platform-shell">
      <a className="platform-skip" href="#panel-content">Ir al contenido</a>
      <aside className="platform-sidebar">
        <Link className="platform-brand" to="/inicio" aria-label="Attendance, panel principal">
          <Icon name="grid" size={28} />
          <span>Attendance<span>.</span><small>Control Center</small></span>
        </Link>

        <div className="platform-navigation">
          <p className="platform-nav-caption">Espacio de trabajo</p>
          <nav aria-label="Navegación principal">
            {navigation.filter((item) => !item.adminOnly || user?.role === 'platform_admin').map((item) => (
              <NavLink key={item.to} to={item.to}>
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
                <Icon name="chevronRight" size={15} />
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="platform-sidebar-bottom">
          <div className="platform-sidebar-note">
            <Icon name="grid" size={21} />
            <p>Un lugar para todas<br />tus instituciones.</p>
          </div>
          {mode === 'local' && <span className="platform-local-mode">Modo local · Recursos simulados</span>}
          <Link className="platform-home-link" to="/">Ir a la portada<Icon name="arrow" size={16} /></Link>
        </div>
      </aside>

      <div className="workspace platform-workspace">
        <div className="platform-workspace-decoration" aria-hidden="true">
          <span className="platform-workspace-mark"><Icon name="grid" size={480} /></span>
          <span className="platform-workspace-orbit" />
        </div>
        <header className="platform-topbar">
          <nav className="platform-breadcrumb" aria-label="Ubicación actual">
            <Link to="/tenants">Plataforma</Link>
            <Icon name="chevronRight" size={14} />
            <span aria-current="page">{currentSection}</span>
          </nav>
          <div className="platform-profile">
            <span className="platform-user-avatar" aria-hidden="true">{user?.name.slice(0, 1).toUpperCase()}</span>
            <div className="platform-user-details">
              <span>{user?.name}</span>
              <small>{user?.role === 'platform_admin' ? 'Administrador de plataforma' : 'Administrador de institución'}</small>
            </div>
            <button className="platform-logout" title="Cerrar sesión" aria-label="Cerrar sesión" onClick={() => {
              void logout().catch((error: Error) => setError(error.message));
            }}>
              <Icon name="logout" size={19} />
            </button>
          </div>
        </header>

        <main className="platform-main" id="panel-content" tabIndex={-1}>
          {error && <p role="alert" className="alert error">{error}</p>}
          <Outlet />
        </main>
        <footer className="platform-footer">
          <span>Attendance<span className="platform-footer-dot">.</span> Control Center</span>
          <span>Gestión de instituciones educativas</span>
        </footer>
      </div>
    </div>
  );
}
