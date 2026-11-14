import { api, post } from '../../../lib/api';
import type { CatalogPlan, PlanDetail, PlanInput, PlanUpdateResult } from '../types';

// La API exige JSON en todo lo que no es GET (protección CSRF): DELETE también envía {}.
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

export const plansService = {
  list: (signal?: AbortSignal) => api<{ items: CatalogPlan[] }>('/plans', { signal }),
  detail: (code: string, signal?: AbortSignal) =>
    api<PlanDetail>(`/plans/${encodeURIComponent(code)}`, { signal }),
  create: (input: PlanInput & { code: string }) => post<PlanDetail>('/plans', input),
  update: (code: string, input: PlanInput & { version: number }) =>
    api<PlanUpdateResult>(`/plans/${encodeURIComponent(code)}`, json('PUT', input)),
  remove: (code: string) =>
    api<void>(`/plans/${encodeURIComponent(code)}`, json('DELETE', {})),
};
