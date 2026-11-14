import { api, post } from '../../../lib/api';
import type { User } from '../types';

export const authService = {
  me: (signal?: AbortSignal) => api<{ user: User }>('/auth/me', { signal }),
  login: (email: string, password: string) =>
    post<{ user: User }>('/auth/login', { email, password }),
  logout: () => post<void>('/auth/logout'),
};
