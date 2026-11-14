import { api, post } from '../../../lib/api';
import type { Operation } from '../../operations/types';
import type { BackupList } from '../types';

export const backupsService = {
  // Consulta S3 y EBS en el momento: tarda unos segundos, no se usa con polling.
  list: (tenantId: string, signal?: AbortSignal) =>
    api<BackupList>(`/tenants/${tenantId}/backups`, { signal }),
  backup: (tenantId: string) =>
    post<Operation>(`/tenants/${tenantId}/operations`, { type: 'backup' }),
  restore: (tenantId: string, backupId: string) =>
    post<Operation>(`/tenants/${tenantId}/operations`, {
      type: 'restore',
      backup_id: backupId,
    }),
};
