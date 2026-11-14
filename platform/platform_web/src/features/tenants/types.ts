import type { Operation } from '../operations/types';

export interface Tenant {
  id: string;
  tenant_id: string;
  name: string;
  contact_email: string;
  timezone: string;
  region: string;
  env: 'test' | 'prod';
  engine: 'terraform' | 'tofu' | 'pulumi' | 'cloudformation';
  plan: string;
  plan_snapshot?: { code: string; name: string; version: number };
  status: string;
  created_at: string;
}

export interface TenantDetail extends Tenant {
  creation: { available: boolean; message: string | null };
  operations: Operation[];
  deployments: {
    id: string;
    created_at: string;
    engine: Tenant['engine'];
    status: 'provisioning' | 'ready' | 'suspended' | 'deleted' | 'failed';
    ami: Record<string, string>;
    outputs: { urls?: Record<string, string | null>; stack_name?: string; stack_id?: string };
    resources: { type: string; role: string; id: string }[];
    tool_versions: Record<string, string | null>;
  }[];
}

export interface Plan {
  code: Tenant['plan'];
  name: string;
  description: string;
  version: number;
  sizing: { frontend: string; backend: string; db: string; db_disk_gb: number };
  limits: { max_students?: number; max_teachers?: number; max_courses?: number };
  backup: { schedule: 'weekly' | 'daily'; retention_days: number } | null;
}

export interface Engine {
  code: Tenant['engine'];
  label: string;
  available: boolean;
}
export const planNames: Record<string, string> = {
  basic: 'Básico',
  standard: 'Estándar',
  advanced: 'Avanzado',
};

export const engineNames: Record<Tenant['engine'], string> = {
  terraform: 'Terraform',
  tofu: 'OpenTofu',
  pulumi: 'Pulumi',
  cloudformation: 'CloudFormation',
};
