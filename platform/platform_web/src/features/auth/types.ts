export interface User {
  id: string;
  name: string;
  email: string;
  role: 'platform_admin' | 'tenant_admin';
  tenant_id: string | null;
}
export type DeploymentMode = 'local' | 'integration';
