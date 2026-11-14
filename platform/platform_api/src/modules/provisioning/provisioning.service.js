// Operaciones de infraestructura del tenant (P2): create, suspend, resume y destroy.
// El worker las toma de la cola de P6 (mismo bloqueo por tenant, eventos, cancelación y
// reintento) y las ejecuta con el adaptador del motor elegido (src/engines).
import { engineAvailable, ENGINES } from '../../engines/adapter.js';
import { HttpError } from '../../lib/errors.js';
import { OperationError, LeaseLost } from '../../worker/errors.js';
import { validateSnapshot, publicDeployment } from '../deployments/deployment-config.js';
import { saveDeployment } from '../deployments/deployments.service.js';
import { getEngineAdapter } from '../../worker/engines/index.js';
import { prepareDeploymentContext, ensureActive } from '../../worker/services/deployment-context.js';
import { checkTenantHealth } from '../../worker/services/tenant-health.js';

export const INFRA_OPERATIONS = ['create', 'suspend', 'resume', 'destroy'];

// Estados del tenant desde los que se admite cada operación. Los estados transitorios
// (provisioning, suspending…) se admiten porque solo quedan así si un worker se interrumpió:
// el índice operations_one_active_per_tenant ya impide dos operaciones activas.
const ALLOWED_FROM = {
  create: ['draft', 'failed', 'provisioning'],
  suspend: ['ready', 'failed', 'suspending'],
  resume: ['suspended', 'failed', 'resuming'],
  destroy: ['draft', 'provisioning', 'ready', 'suspending', 'suspended', 'resuming', 'deleting', 'failed'],
};
const METHOD = { create: 'apply', suspend: 'suspend', resume: 'resume', destroy: 'destroy' };

/** Validación al encolar (API). Lanza HttpError con un mensaje para la UI. */
export function assertCanEnqueue(tenant, type, params = {}) {
  if (!INFRA_OPERATIONS.includes(type)) return;
  if (!engineAvailable(tenant.engine))
    throw new HttpError(
      409,
      'ENGINE_NOT_AVAILABLE',
      `El motor ${ENGINES[tenant.engine]?.label ?? tenant.engine} todavía no está conectado al worker.`,
    );
  if (!ALLOWED_FROM[type].includes(tenant.status))
    throw new HttpError(
      409,
      'INVALID_TENANT_STATE',
      `No se puede ejecutar "${type}" con la institución en estado ${tenant.status}.`,
    );
  // RF-18: eliminar exige escribir el identificador del tenant (la UI muestra antes la lista).
  if (type === 'destroy' && params.confirm !== tenant.tenant_id)
    throw new HttpError(
      400,
      'CONFIRMATION_REQUIRED',
      `Para eliminar escribe el identificador "${tenant.tenant_id}" en confirm.`,
    );
}

/** Handler de P2 para suspend/resume/destroy; create usa el handler común de P6.
 * La finalización pertenece al worker: nunca cambiar el estado sin comprobar su dueño.
 */
export async function runInfraOperation({ pool, config, operation, workerId, report, signal, adapters, creationServices = {} }) {
  if (!['suspend', 'resume', 'destroy'].includes(operation.type))
    throw new OperationError('UNSUPPORTED_OPERATION', 'La operación no corresponde a este handler de infraestructura.');
  const tenant = (await pool.query('SELECT * FROM tenants WHERE id=$1', [operation.tenant_id])).rows[0];
  if (!tenant) throw new OperationError('TENANT_NOT_FOUND', 'La institución ya no existe.');
  const snapshot = validateSnapshot(operation.params?.deployment, tenant);
  const adapter = getEngineAdapter(tenant.engine, adapters);
  const type = operation.type;
  const context = await prepareDeploymentContext({ config, tenant, snapshot, operation, report, signal });
  context.input = { ...context.input, suspended: type === 'suspend' };
  await adapter.preflight?.(context);
  ensureActive(signal);
  if (typeof adapter[METHOD[type]] !== 'function')
    throw new OperationError('ENGINE_NOT_AVAILABLE', 'El motor no admite esta operación de infraestructura.');
  const result = await adapter[METHOD[type]](context);
  ensureActive(signal);
  if (result?.status !== 'succeeded')
    throw new OperationError('ENGINE_FAILED', 'El motor no pudo completar el cambio de infraestructura.');
  if (type === 'destroy') {
    await report('Recursos del tenant eliminados. La red compartida y los buckets se conservan.', { stage: 'Finalizando eliminación', progress: 95 });
    return { status: 'succeeded' };
  }
  const deployment = publicDeployment(result.outputs, result.tool_versions, snapshot, { suspended: type === 'suspend' });
  const id = await saveDeployment(pool, operation, workerId, deployment);
  if (type === 'resume') {
    await report('Comprobando los accesos nuevos y la salud de Attendance.', { stage: 'Comprobando salud', progress: 85 });
    const health = await (creationServices.checkHealth ?? checkTenantHealth)({
      tenant: snapshot.input, url: deployment.outputs.urls.frontend, projectName: snapshot.input.base.project_name,
      config, signal, report,
    });
    ensureActive(signal);
    const saved = await pool.query(`UPDATE deployments SET health=$3 WHERE id=$1 AND operation_id=$2
      AND EXISTS (SELECT 1 FROM operations WHERE id=$2 AND worker_id=$4 AND status='running')`,
      [id, operation.id, health, workerId]);
    if (!saved.rowCount) throw new LeaseLost();
    if (health.status !== 'healthy')
      throw new OperationError('TENANT_UNHEALTHY', 'Las EC2 arrancaron, pero Attendance todavía no está sano. Revisa y reintenta con el mismo estado.');
  }
  ensureActive(signal);
  await report(type === 'suspend' ? 'EC2 detenidas; discos y datos conservados.' : 'Attendance responde en sus accesos actuales.',
    { stage: 'Finalizando operación', progress: 95 });
  return { deployment_id: id, urls: deployment.outputs.urls, instance_ids: deployment.outputs.instance_ids };
}
