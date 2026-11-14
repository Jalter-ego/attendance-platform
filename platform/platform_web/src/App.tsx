import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AuthProvider } from './features/auth/context/AuthProvider';
import { useAuth } from './features/auth/hooks/useAuth';
import { LoginPage } from './features/auth/pages/LoginPage';
import { PlatformLayout } from './components/PlatformLayout';
import { TenantsPage } from './features/tenants/pages/TenantsPage';
import { CreateTenantPage } from './features/tenants/pages/CreateTenantPage';
import { TenantDetailPage } from './features/tenants/pages/TenantDetailPage';
import { BackupsPage } from './features/backups/pages/BackupsPage';
import { AuditPage, MonitoringPage } from './features/operations/ActivityPage';
import { DemoTenantPage, LandingPage } from './features/landing/LandingPage';
import { PlansPage } from './features/plans/pages/PlansPage';
import './App.css';
import './p6.css';

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <div className="screen-state">Cargando plataforma…</div>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function RequirePlatformAdmin() {
  const { user } = useAuth();
  return user?.role === 'platform_admin' ? <Outlet /> : <Navigate to="/tenants" replace />;
}

function PublicHome() {
  const { hash } = useLocation();
  const legacy = hash.slice(1);
  if (/^\/(login|tenants(?:\/[a-f0-9-]+)?|plans|audit|monitoring|demo\/[a-f0-9-]+)$/i.test(legacy))
    return <Navigate to={legacy} replace />;
  return <LandingPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<PublicHome />} />
          <Route path="/inicio" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<PlatformLayout />}>
              <Route path="/demo/:id" element={<DemoTenantPage />} />
              <Route path="/tenants" element={<TenantsPage />} />
              <Route element={<RequirePlatformAdmin />}>
                <Route path="/tenants/new" element={<CreateTenantPage />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/monitoring" element={<MonitoringPage />} />
                <Route path="/audit" element={<AuditPage />} />
              </Route>
              <Route path="/tenants/:id" element={<TenantDetailPage />} />
              <Route path="/backups" element={<BackupsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/tenants" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
