// Operaciones de infraestructura del tenant (P2): create, suspend, resume y destroy.
// El worker las toma de la cola de P6 (mismo bloqueo por tenant, eventos, cancelación y
// reintento) y las ejecuta con el adaptador del motor elegido (src/engines).
import { randomUUID } from 'node:crypto';
import { transaction } from '../../db/pool.js';
import { getAdapter, engineAvailable, ENGINES } from '../../engines/adapter.js';
import { buildTenantInput } from '../../engines/tenant-input.js';
import { waitForHealth } from '../../engines/health.js';
import { HttpError } from '../../lib/errors.js';
import { OperationError } from '../../worker/errors.js';
import { ensureTenantSecrets } from '../../worker/services/tenant-secrets.js';

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
const TRANSITION = {
  create: { running: 'provisioning', done: 'ready' },
  suspend: { running: 'suspending', done: 'suspended' },
  resume: { running: 'resuming', done: 'ready' },
  destroy: { running: 'deleting', done: 'deleted' },
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

async function setStatus(pool, tenantId, status) {
  await pool.query('UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1', [
    tenantId,
    status,
  ]);
}

async function saveDeployment(pool, tenant, operation, result, input) {
  await transaction(pool, async (client) => {
    await client.query(
      'INSERT INTO deployments(id, tenant_id, operation_id, engine, ami, outputs, resources, tool_versions, status, log_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        randomUUID(),
        tenant.id,
        operation.id,
        tenant.engine,
        input.ami,
        result.outputs,
        JSON.stringify(result.resources),
        result.tool_versions,
        result.status,
        result.log_ref,
      ],
    );
  });
}

/** Handler del worker para create/suspend/resume/destroy. */
export async function runInfraOperation({ pool, config, operation, report, signal }) {
  const { rows } = await pool.query(
    'SELECT t.*, row_to_json(p) AS plan_row FROM tenants t JOIN plans p ON p.code = t.plan WHERE t.id = $1',
    [operation.tenant_id],
  );
  if (!rows.length) throw new OperationError('TENANT_NOT_FOUND', 'La institución ya no existe.');
  const tenant = rows[0];
  const type = operation.type;
  const transition = TRANSITION[type];
  await setStatus(pool, tenant.id, transition.running);
  try {
    const input = await buildTenantInput(config, tenant, tenant.plan_row, {
      suspended: type === 'suspend',
    });
    const adapter = getAdapter(tenant.engine, config);
    await report(
      `${type} de ${tenant.tenant_id}/${tenant.env} con ${adapter.label}: plan ${tenant.plan}${input.plan_version ? ` v${input.plan_version}` : ''}, AMIs ${input.image.version ?? 'sin versión'}.`,
      { stage: 'Validando la solicitud', progress: 5 },
    );
    if (type === 'create') {
      // Servicio SSM de P6: crea los SecureString que faltan y conserva los existentes.
      // config.ssmClient solo existe en pruebas (cliente simulado).
      const secrets = await ensureTenantSecrets(tenant, {
        signal,
        projectName: input.base.project_name,
        client: config.ssmClient,
      });
      const names = (list) => list.map((name) => name.split('/').pop()).join(', ') || 'ninguno';
      await report(
        `Secretos en SSM (${secrets.ssm_prefix}/): creados [${names(secrets.created)}], reutilizados [${names(secrets.reused)}]. Los valores no se muestran.`,
        { stage: 'Secretos del tenant listos', progress: 8 },
      );
    }
    const ctx = { input, report, signal, logRef: `operations/${operation.id}` };
    const result = await adapter[METHOD[type]](ctx);
    if (type === 'create' || type === 'resume') {
      const urls = result.outputs.urls ?? {};
      await report('Esperando que frontend y backend respondan (cloud-init y Ansible).', {
        stage: 'Comprobando la salud',
        progress: 85,
      });
      await waitForHealth(
        { frontend: urls.frontend_health, backend: urls.backend_health },
        {
          timeoutMs: config.HEALTH_TIMEOUT_S * 1000,
          signal,
          onWait: (pending, elapsed) =>
            report(`Aún arrancando (${elapsed} s): ${pending.join(', ')}.`),
        },
      );
      await report(`Tenant disponible en ${urls.frontend}.`, {
        stage: 'Servicios respondiendo',
        progress: 95,
      });
    }
    if (type !== 'destroy') await saveDeployment(pool, tenant, operation, result, input);
    await setStatus(pool, tenant.id, transition.done);
    await report(
      {
        create: 'Tenant creado y verificado.',
        suspend: 'Tenant suspendido: EC2 detenidas, discos y datos conservados.',
        resume: 'Tenant reanudado con URLs actualizadas.',
        destroy: 'Tenant eliminado. La red compartida y los buckets se conservan.',
      }[type],
      { stage: 'Completada', progress: 100 },
    );
    return result;
  } catch (error) {
    // El reintento vuelve a aplicar sobre el mismo estado: completa lo pendiente sin duplicar.
    await setStatus(pool, tenant.id, 'failed').catch(() => {});
    throw error;
  }
}
