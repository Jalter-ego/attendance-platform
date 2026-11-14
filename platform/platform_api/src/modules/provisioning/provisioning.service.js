// Validación del contrato original de P2 para las operaciones de infraestructura.
// La cola compartida hace cumplir la vista previa de eliminación y el bloqueo.
import { engineAvailable, ENGINES } from '../../engines/adapter.js';
import { HttpError } from '../../lib/errors.js';

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
