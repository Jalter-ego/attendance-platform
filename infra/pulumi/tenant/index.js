// Programa Pulumi del tenant. La entrada es la misma que reciben Terraform y CloudFormation
// (platform_api/src/engines/tenant-input.js) y llega en la configuración del stack:
//   pulumi config set attendance-tenant:input '<json>'
// No contiene secretos: las contraseñas viven en SSM (/tenants/<id>/<env>/).
import * as pulumi from '@pulumi/pulumi';
import { createTenant } from './tenant.js';

const stack = createTenant(new pulumi.Config().requireObject('input'));

export const {
  deployment_name, urls, suspended, instance_ids, private_ips, db_volume_id, ssm_prefix,
  instance_role_arns, ami_ids, backup, releases,
} = stack;
