import { api, post } from '../../../lib/api';
import type { Engine, Tenant, TenantDetail, Plan } from '../types';

type TenantInput = Pick<
  Tenant,
  'tenant_id' | 'name' | 'contact_email' | 'timezone' | 'region' | 'env' | 'engine' | 'plan'
>;

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
    api<{ items: Engine[]; mode: 'local' | 'integration' }>('/engines', { signal }),
  register: (input: TenantInput) =>
    post<Tenant>('/tenants', input),
  provision: (input: TenantInput & { simulate_failure?: boolean }) =>
    post<{ tenant: Tenant }>('/tenants/provision', input),
};
