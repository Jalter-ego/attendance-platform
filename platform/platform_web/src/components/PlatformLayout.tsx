import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../features/auth/hooks/useAuth';
import { Icon } from './Icon';

export function PlatformLayout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [error, setError] = useState('');
  return (
    <div className="platform-layout">
      <aside className="sidebar">
        <NavLink className="brand" to="/tenants">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <span>
            attendance<small>CONTROL CENTER</small>
          </span>
        </NavLink>
        <div className="nav-caption">ESPACIO DE TRABAJO</div>
        <nav aria-label="Navegación principal">
          <NavLink to="/tenants">
            <Icon name="building" />
            Instituciones
            <Icon name="arrow" size={16} />
          </NavLink>
          <NavLink to="/backups">
            <Icon name="archive" />
            Respaldos
            <Icon name="arrow" size={16} />
          </NavLink>
          <NavLink to="/plans">
            <Icon name="layers" />
            Planes
            <Icon name="arrow" size={16} />
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="environment-dot" />
          Administración de Attendance
          <p>Una plataforma para todas tus instituciones.</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Plataforma <span className="breadcrumb-divider">/</span>{' '}
            {pathname.startsWith('/backups')
              ? 'Respaldos'
              : pathname.startsWith('/plans')
                ? 'Planes'
                : 'Instituciones'}
          </span>
          <div className="profile">
            <span className="avatar">
              {user?.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              {user?.name}
              <small>
                {user?.role === 'platform_admin'
                  ? 'Administrador de plataforma'
                  : 'Administrador de institución'}
              </small>
            </span>
            <button
              className="icon-button"
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
              onClick={() => {
                void logout().catch((error: Error) => setError(error.message));
              }}
            >
              <Icon name="logout" />
            </button>
          </div>
        </header>
        <main>
          {error && (
            <p role="alert" className="alert error">
              {error}
            </p>
          )}
          <Outlet />
        </main>
        <footer>
          Attendance Control Center <span>Gestión de instituciones</span>
        </footer>
      </div>
    </div>
  );
}
