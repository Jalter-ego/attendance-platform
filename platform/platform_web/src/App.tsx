import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from 'react-router-dom';
import { AuthProvider } from './features/auth/context/AuthProvider';
import { useAuth } from './features/auth/hooks/useAuth';
import { LoginPage } from './features/auth/pages/LoginPage';
import { PlatformLayout } from './components/PlatformLayout';
import { TenantsPage } from './features/tenants/pages/TenantsPage';
import { CreateTenantPage } from './features/tenants/pages/CreateTenantPage';
import { TenantDetailPage } from './features/tenants/pages/TenantDetailPage';
import { BackupsPage } from './features/backups/pages/BackupsPage';
import { PlansPage } from './features/plans/pages/PlansPage';
import './App.css';

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <div className="screen-state">Cargando plataforma…</div>;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<PlatformLayout />}>
              <Route path="/tenants" element={<TenantsPage />} />
              <Route path="/tenants/new" element={<CreateTenantPage />} />
              <Route path="/tenants/:id" element={<TenantDetailPage />} />
              <Route path="/backups" element={<BackupsPage />} />
              <Route path="/plans" element={<PlansPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/tenants" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
