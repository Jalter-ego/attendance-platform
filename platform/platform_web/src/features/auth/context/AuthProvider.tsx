import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthContext } from './auth-context';
import { authService } from '../services/auth.service';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Awaited<ReturnType<typeof authService.me>> | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    authService
      .me(controller.signal)
      .then((session) => {
        if (!controller.signal.aborted) setSession(session);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSession(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const expired = () => setSession(null);
    window.addEventListener('platform:unauthenticated', expired);
    return () => {
      controller.abort();
      window.removeEventListener('platform:unauthenticated', expired);
    };
  }, []);
  async function login(email: string, password: string) {
    setSession(await authService.login(email, password));
  }
  async function logout() {
    await authService.logout();
    setSession(null);
  }
  return (
    <AuthContext.Provider value={{ user: session?.user ?? null, mode: session?.mode ?? null, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
