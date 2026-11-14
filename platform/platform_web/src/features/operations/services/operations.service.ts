import { api, post } from '../../../lib/api';
import type { Operation, OperationEvent } from '../types';

export const operationsService = {
  get: (id: string, signal?: AbortSignal) =>
    api<Operation>(`/operations/${id}`, { signal }),
  logs: (id: string, after: string, signal?: AbortSignal) =>
    api<{ items: OperationEvent[]; next_cursor: string; has_more: boolean }>(
      `/operations/${id}/logs?after=${after}`,
      { signal },
    ),
  diagnostic: (tenantId: string) =>
    post<Operation>(`/tenants/${tenantId}/operations`, { type: 'diagnostic' }),
  // P2: infraestructura con el motor del tenant (create/suspend/resume/destroy).
  infra: (
    tenantId: string,
    body:
      | { type: 'create' | 'suspend' | 'resume' }
      | { type: 'destroy'; confirm: string },
  ) => post<Operation>(`/tenants/${tenantId}/operations`, body),
  cancel: (id: string) => post<Operation>(`/operations/${id}/cancel`),
  retry: (id: string) => post<Operation>(`/operations/${id}/retry`),
};
