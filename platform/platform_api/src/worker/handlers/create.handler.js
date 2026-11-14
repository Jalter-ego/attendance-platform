import { getEngineAdapter } from '../engines/index.js';
import { ensureTenantSecrets } from '../services/tenant-secrets.js';
import { checkTenantHealth } from '../services/tenant-health.js';
import { prepareDeploymentContext, ensureActive } from '../services/deployment-context.js';
import { validateSnapshot, publicDeployment } from '../../modules/deployments/deployment-config.js';
import { saveDeployment } from '../../modules/deployments/deployments.service.js';
import { OperationError, LeaseLost } from '../errors.js';

export async function runCreateOperation({
  pool, config, operation, workerId, signal, report, adapters, creationServices = {},
}) {
  const tenant = (await pool.query('SELECT * FROM tenants WHERE id = $1', [operation.tenant_id])).rows[0];
  if (!tenant) throw new OperationError('TENANT_NOT_FOUND', 'La institución ya no existe.');
  const snapshot = validateSnapshot(operation.params?.deployment, tenant);
  const adapter = getEngineAdapter(snapshot.input.engine, adapters);
  const active = () => ensureActive(signal);
  const context = await prepareDeploymentContext({ config, tenant, snapshot, operation, signal, report });
  if (tenant.engine === 'cloudformation') {
    const { rows: [previous] } = await pool.query(
      "SELECT outputs->>'stack_id' AS stack_id FROM deployments WHERE tenant_id=$1 AND outputs ? 'stack_id' ORDER BY created_at DESC,id DESC LIMIT 1",
      [tenant.id],
    );
    context.enforceStackOwnership = true;
    context.deployedStackId = previous?.stack_id;
  }
  // Validar binarios/prerrequisitos antes de escribir secretos (opcional para P2).
  await adapter.preflight?.(context);
  active();
  await report('Preparando las credenciales propias de la institución.', { stage: 'Preparando secretos', progress: 15 });
  await (creationServices.prepareSecrets ?? ensureTenantSecrets)(snapshot.input, { signal, projectName: snapshot.input.base.project_name, client: config.ssmClient });
  await report('Creando o completando los recursos con el estado de esta institución.', { stage: 'Creando infraestructura', progress: 25 });
  active();
  const applied = await adapter.apply(context);
  if (applied?.status !== 'succeeded') throw new OperationError('CREATE_APPLY_FAILED', 'El motor no pudo completar la infraestructura. Revisa los eventos antes de reintentar.');
  active();
  const outputs = applied.outputs ?? await adapter.outputs(context);
  const versions = applied.tool_versions ?? await adapter.versions(context);
  const deployment = publicDeployment(outputs, versions, snapshot);
  if (snapshot.backend.type !== 'cloudformation') {
    const { bucket, region, key } = snapshot.backend;
    deployment.outputs.state = { tenant: tenant.id, engine: tenant.engine, bucket, region, key };
  }
  const deploymentId = await saveDeployment(pool, operation, workerId, deployment);
  await report('Recursos y accesos guardados. Esperando que Attendance termine de arrancar.', { stage: 'Comprobando salud', progress: 80 });
  active();
  const health = await (creationServices.checkHealth ?? checkTenantHealth)({
    tenant: snapshot.input, url: deployment.outputs.urls.frontend, projectName: snapshot.input.base.project_name,
    config, signal, report,
  });
  active();
  // Guardar solamente el contrato validado por checkTenantHealth; nunca body/boot.
  const saved = await pool.query(
    `UPDATE deployments SET health = $3,
       outputs = jsonb_set(outputs, '{health}', $5::jsonb) WHERE id = $1 AND operation_id = $2
     AND EXISTS (SELECT 1 FROM operations WHERE id=$2 AND worker_id=$4 AND status='running')`,
    [deploymentId, operation.id, health, workerId, health.status === 'healthy'
      ? { frontend: 'healthy', backend: 'healthy', database: 'healthy' } : {}],
  );
  if (!saved.rowCount) throw new LeaseLost();
  active();
  if (health.status !== 'healthy') throw new OperationError('TENANT_UNHEALTHY', 'Los servidores se crearon, pero Attendance todavía no está sano. Revisa el frontend, la API y la base; el reintento conserva el mismo estado.');
  await report('Attendance responde correctamente y su base está disponible.', { stage: 'Finalizando instalación', progress: 95 });
  return { deployment_id: deploymentId, urls: deployment.outputs.urls, instance_ids: deployment.outputs.instance_ids };
}
