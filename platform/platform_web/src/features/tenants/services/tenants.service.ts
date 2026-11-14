import { api, post } from '../../../lib/api';
import type { Tenant, TenantDetail, Plan } from '../types';

export const tenantsService = {
  list: (query: string, signal?: AbortSignal) =>
    api<{ items: Tenant[]; total: number; limit: number; offset: number }>(
      `/tenants?${query}`,
      { signal },
    ),
  detail: (id: string, signal?: AbortSignal) =>
    api<TenantDetail>(`/tenants/${id}`, { signal }),
  plans: (signal?: AbortSignal) => api<{ items: Plan[] }>('/plans', { signal }),
  register: (input: Omit<Tenant, 'id' | 'status' | 'created_at' | 'region'>) =>
    post<Tenant>('/tenants', input),
};
