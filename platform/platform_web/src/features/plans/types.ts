// Catálogo de planes (P4 · F4). Mismo modelo que platform_api/src/modules/plans.

export const INSTANCE_SIZES = ['t3.micro', 't3.small', 't3.medium', 't3.large'] as const;
export type InstanceSize = (typeof INSTANCE_SIZES)[number];

export interface PlanSizing {
  frontend: string;
  backend: string;
  db: string;
  db_disk_gb: number;
}

export interface PlanLimits {
  max_students?: number;
  max_teachers?: number;
  max_courses?: number;
}

export interface PlanBackup {
  schedule: 'weekly' | 'daily';
  retention_days: number;
}

export interface CatalogPlan {
  code: string;
  name: string;
  description: string;
  sizing: PlanSizing;
  limits: PlanLimits;
  backup: PlanBackup;
  version: number;
  updated_at: string;
  tenants: { total: number; outdated: number };
}

export interface PlanTenant {
  id: string;
  tenant_id: string;
  env: 'test' | 'prod';
  name: string;
  status: string;
  plan_version: number;
}

export interface PlanDetail extends CatalogPlan {
  tenant_list: PlanTenant[];
}

export interface PlanInput {
  name: string;
  description: string;
  sizing: PlanSizing;
  limits: PlanLimits;
  backup: PlanBackup;
}

export interface PlanUpdateResult {
  plan: PlanDetail;
  changed: boolean;
  unchanged_tenants: number;
  warning: string | null;
}

// Las tres políticas que admite el módulo de tenant (P1) y la ruta de DLM/S3 (P3).
export const BACKUP_OPTIONS: { value: string; label: string; backup: PlanBackup }[] = [
  { value: 'weekly-28', label: 'Semanal · 28 días', backup: { schedule: 'weekly', retention_days: 28 } },
  { value: 'daily-14', label: 'Diario · 14 días', backup: { schedule: 'daily', retention_days: 14 } },
  { value: 'daily-30', label: 'Diario · 30 días', backup: { schedule: 'daily', retention_days: 30 } },
];

export const backupValue = (backup: PlanBackup) => `${backup.schedule}-${backup.retention_days}`;

export function backupLabel(backup: PlanBackup | null | undefined) {
  if (!backup) return 'Sin respaldo programado';
  return `${backup.schedule === 'daily' ? 'Diario' : 'Semanal'} · ${backup.retention_days} días`;
}

export const LIMIT_FIELDS: { key: keyof PlanLimits; label: string; help: string }[] = [
  { key: 'max_students', label: 'Estudiantes', help: 'En módulos no archivados de la app.' },
  { key: 'max_teachers', label: 'Docentes', help: 'Usuarios activos de la app (incluye al administrador).' },
  { key: 'max_courses', label: 'Cursos', help: 'Módulos académicos en borrador o activos.' },
];
