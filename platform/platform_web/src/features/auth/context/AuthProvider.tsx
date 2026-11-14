import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthContext } from './auth-context';
import { authService } from '../services/auth.service';
import type { User } from '../types';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    authService
      .me(controller.signal)
      .then(({ user }) => {
        if (!controller.signal.aborted) setUser(user);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUser(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const expired = () => setUser(null);
    window.addEventListener('platform:unauthenticated', expired);
    return () => {
      controller.abort();
      window.removeEventListener('platform:unauthenticated', expired);
    };
  }, []);
  async function login(email: string, password: string) {
    setUser((await authService.login(email, password)).user);
  }
  async function logout() {
    await authService.logout();
    setUser(null);
  }
  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
