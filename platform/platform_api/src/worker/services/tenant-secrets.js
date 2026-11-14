import { randomBytes } from 'node:crypto';
import { SSMClient, DescribeParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { tenantInput } from '../../modules/tenants/tenants.service.js';
import { OperationCancelled, OperationError } from '../errors.js';

const identity = tenantInput.pick({ tenant_id: true, env: true, region: true }).strip();
const keys = ['db_password', 'jwt_secret', 'admin_password'];

/** Prepara SSM antes del apply. Devuelve nombres, nunca valores ni credenciales. */
export async function ensureTenantSecrets(tenant, {
  client, signal, timeoutMs = 60000, projectName = 'attendance-platform',
} = {}) {
  const parsed = identity.safeParse(tenant);
  if (!parsed.success || !/^[a-z][a-z0-9-]{2,39}$/.test(projectName) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new OperationError('SSM_CONFIG', 'Revisa el identificador, entorno y región de la institución.');
  const { tenant_id, env, region } = parsed.data;
  const prefix = `/tenants/${tenant_id}/${env}`;
  const deadline = AbortSignal.timeout(timeoutMs);
  const jobSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const active = () => {
    if (signal?.aborted) throw new OperationCancelled();
    if (deadline.aborted) throw new OperationError('SSM_TIMEOUT', 'La preparación de secretos superó el tiempo máximo. Se pueden reintentar los pendientes.');
  };
  active();
  const ssm = client ?? new SSMClient({ region, maxAttempts: 3 });
  const result = { ssm_prefix: prefix, created: [], reused: [] };
  const send = async (command) => {
    active();
    const response = await ssm.send(command, { abortSignal: jobSignal });
    active();
    return response;
  };
  const existing = async (name) => {
    let NextToken;
    do {
      const page = await send(new DescribeParametersCommand({
        ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: [name] }], NextToken,
      }));
      const parameter = page.Parameters?.find((item) => item.Name === name);
      if (parameter) {
        if (parameter.Type !== 'SecureString') throw new OperationError(
          'SSM_INSECURE_PARAMETER', 'Hay un parámetro del tenant que no es SecureString. Revísalo antes de desplegar.',
        );
        return true;
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return false;
  };
  try {
    for (const key of keys) {
      const name = `${prefix}/${key}`;
      if (await existing(name)) { result.reused.push(name); continue; }
      try {
        await send(new PutParameterCommand({
          Name: name, Type: 'SecureString', Value: randomBytes(32).toString('hex'),
          KeyId: 'alias/aws/ssm', Tier: 'Standard', Overwrite: false,
          Tags: [{ Key: 'Project', Value: projectName }, { Key: 'Tenant', Value: tenant_id }, { Key: 'Env', Value: env }],
        }));
        result.created.push(name);
      } catch (error) {
        // Otro intento pudo crearlo después del describe: nunca sobrescribirlo.
        if (error.name !== 'ParameterAlreadyExists' || !(await existing(name))) throw error;
        result.reused.push(name);
      }
    }
    return result;
  } catch (error) {
    active();
    if (error instanceof OperationError || error instanceof OperationCancelled) throw error;
    const denied = /AccessDenied|Unauthorized/.test(error.name);
    throw new OperationError(
      denied ? 'SSM_ACCESS_DENIED' : 'SSM_PREPARE_FAILED',
      denied ? 'El worker no tiene permisos para preparar los secretos en SSM.'
        : 'No se pudieron preparar los secretos en SSM. Revisa las credenciales, región y conexión del worker; el reintento conserva los existentes.',
    );
  } finally {
    if (!client) ssm.destroy();
  }
}
