import { api, post } from '../../../lib/api';
import type { DeploymentMode, User } from '../types';

type Session = { user: User; mode: DeploymentMode };

export const authService = {
  me: (signal?: AbortSignal) => api<Session>('/auth/me', { signal }),
  login: (email: string, password: string) =>
    post<Session>('/auth/login', { email, password }),
  logout: () => post<void>('/auth/logout'),
};
