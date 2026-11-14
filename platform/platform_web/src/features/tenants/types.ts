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
    outputs: { urls?: Record<string, string | null> };
    tool_versions: Record<string, string>;
  }[];
}

export interface Plan {
  code: Tenant['plan'];
  name: string;
}
export const planNames = {
  basic: 'Básico',
  standard: 'Estándar',
  advanced: 'Avanzado',
};
