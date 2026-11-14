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
  plan: 'basic' | 'standard' | 'advanced';
  status: string;
  created_at: string;
}

export interface TenantDetail extends Tenant {
  operations: Operation[];
  deployments: {
    id: string;
    created_at: string;
    engine: Tenant['engine'];
    status: string;
    ami: Record<string, string>;
    outputs: { urls?: Record<string, string | null> };
    resources: { type: string; role: string; id: string }[];
    tool_versions: Record<string, string | null>;
  }[];
}

export interface Plan {
  code: Tenant['plan'];
  name: string;
  sizing: { frontend: string; backend: string; db: string; db_disk_gb: number };
  limits: { max_students?: number; max_teachers?: number; max_courses?: number };
  backup: { schedule: 'weekly' | 'daily'; retention_days: number } | null;
}

export interface Engine {
  code: Tenant['engine'];
  label: string;
  available: boolean;
}
export const planNames = {
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
