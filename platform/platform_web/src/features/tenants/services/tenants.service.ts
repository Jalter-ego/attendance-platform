import { api, post } from '../../../lib/api';
import type { Engine, Tenant, TenantDetail, Plan } from '../types';

export const tenantsService = {
  list: (query: string, signal?: AbortSignal) =>
    api<{ items: Tenant[]; total: number; limit: number; offset: number }>(
      `/tenants?${query}`,
      { signal },
    ),
  detail: (id: string, signal?: AbortSignal) =>
    api<TenantDetail>(`/tenants/${id}`, { signal }),
  plans: (signal?: AbortSignal) => api<{ items: Plan[] }>('/plans', { signal }),
  engines: (signal?: AbortSignal) =>
    api<{ items: Engine[] }>('/engines', { signal }),
  register: (input: Omit<Tenant, 'id' | 'status' | 'created_at'>) =>
    post<Tenant>('/tenants', input),
};
