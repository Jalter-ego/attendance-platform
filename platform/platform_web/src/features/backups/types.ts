export interface BackupItem {
  backup_id: string;
  type: 'manual' | 'scheduled' | 'pre-restore' | string;
  created_at: string | null;
  dump: { key: string; bytes: number; last_modified: string } | null;
  snapshot: {
    snapshot_id: string;
    state: string;
    gib: number;
    started: string;
  } | null;
  restorable: boolean;
}

export interface BackupList {
  tenant_id: string;
  env: 'test' | 'prod';
  bucket: string;
  items: BackupItem[];
}

export const backupTypeNames: Record<string, string> = {
  manual: 'Manual',
  scheduled: 'Programado',
  'pre-restore': 'Previo a restaurar',
};
