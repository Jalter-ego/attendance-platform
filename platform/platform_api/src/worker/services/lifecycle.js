import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OperationError } from '../errors.js';
import { recoverLegacyTransition } from '../../modules/deployments/deployments.service.js';
import { validateSnapshot } from '../../modules/deployments/deployment-config.js';

export const isLocalBackup = (type, config) => config?.PLATFORM_DEPLOY_MODE === 'local' && ['backup', 'restore'].includes(type);
export const isLifecycle = (type) =>
  ['create', 'suspend', 'resume', 'delete', 'upgrade', 'plan-change', 'preview-plan', 'preview-delete'].includes(type);
const lifecycleError = (message) => new OperationError('LIFECYCLE_ERROR', message);

const outputsFor = (tenant, status, resources) => ({
  mode: 'local',
  urls: { frontend: status === 'ready' ? `/demo/${tenant.id}` : null },
  health: status === 'ready' ? { frontend: 'healthy', backend: 'healthy', database: 'healthy' } : {},
  instance_ids: Object.fromEntries(resources.filter(({ role }) => role !== 'data').map(({ role, id }) => [role, id])),
  private_ips: {},
});

function simulatedResources(tenant, plan, previous = []) {
  return ['frontend', 'backend', 'db', 'data'].map((role) => ({
    id: previous.find((resource) => resource.role === role)?.id ?? `local-${tenant.id}-${role}`,
    role,
    name: { frontend: 'Frontend', backend: 'Backend', db: 'Base de datos', data: 'Disco de datos' }[role],
    size: role === 'data' ? `${plan.sizing.db_disk_gb} GiB` : plan.sizing[role],
  }));
}

async function simulate({ tenant, plan, operation, deployment, inventory, report, signal, stepDelayMs, pool }) {
  const { type, params } = operation;
  const previousResources = inventory?.resources ?? deployment?.resources ?? [];
  const resources = simulatedResources(tenant, plan, previousResources);
  if (type === 'preview-plan' || type === 'preview-delete') {
    const deleting = type === 'preview-delete';
    const resourceChanges = deleting
      ? previousResources.map(({ name }) => `Se eliminará: ${name}`)
      : resources.flatMap(({ name, role, size }) => {
          const before = previousResources.find((resource) => resource.role === role)?.size;
          return size !== before ? [`${name}: ${before ?? '—'} → ${size}`] : [];
        });
    await report('Vista previa calculada para el entorno local.', { stage: 'Vista previa', progress: 90 });
    return { result: {
      summary: deleting ? 'Eliminar los recursos simulados del tenant' : 'Cambiar el plan del tenant',
      changes: resourceChanges,
      downtime: resourceChanges.length > 0,
    } };
  }

  if (type === 'backup' || type === 'restore') {
    if (type === 'backup') {
      await report('Creando respaldo simulado.', { stage: 'Respaldando', progress: 70 });
      return { backupId: operation.id, result: { id: operation.id } };
    }
    const { rows } = await pool.query(
      "SELECT id FROM local_backups WHERE tenant_id=$1 AND ($2='latest' OR id=$2) ORDER BY created_at DESC LIMIT 1",
      [tenant.id, params.backup_id],
    );
    if (!rows.length) throw lifecycleError('El respaldo seleccionado no existe.');
    await report('Restauración simulada completada.', { stage: 'Restaurando', progress: 90 });
    return { result: { id: rows[0].id } };
  }

  await report(inventory && type === 'create' ? 'Reutilizando los recursos del intento anterior.' : 'Configurando los recursos simulados.', { stage: 'Configurando', progress: 35 });
  await sleep(stepDelayMs, undefined, { signal });
  const nextInventory = { resources };
  if (type === 'create' && params.simulate_failure && !operation.retry_of && !inventory) {
    return { failure: 'Fallo simulado después de crear recursos. Reintenta para continuar sobre el mismo estado.', inventory: nextInventory };
  }
  const tenantStatus = type === 'delete' ? 'deleted' : type === 'suspend' ? 'suspended' : 'ready';
  const versions = { IaC: `${tenant.engine} (simulado)`, app: '1.0.0-local', ...deployment?.tool_versions };
  if (type === 'upgrade') versions[params.scope === 'infra' ? 'Infraestructura' : params.component ?? 'backend'] = params.version;
  await report(tenantStatus === 'ready' ? 'Comprobando frontend, backend y base de datos.' : 'Aplicando el nuevo estado del tenant.', { stage: 'Verificando', progress: 90 });
  const remaining = tenantStatus === 'deleted' ? [] : resources;
  return {
    tenantStatus,
    deployment: { ami: {}, outputs: outputsFor(tenant, tenantStatus, remaining), resources: remaining, tool_versions: versions },
    inventory: tenantStatus === 'deleted' ? null : nextInventory,
  };
}

export async function runLifecycle(context) {
  const { pool, config, operation } = context;
  const { rows: [tenant] } = await pool.query('SELECT * FROM tenants WHERE id=$1', [operation.tenant_id]);
  if (!tenant) throw lifecycleError('La institución ya no existe.');
  const plan = operation.params.plan_snapshot ?? tenant.plan_snapshot;
  if (!plan) throw lifecycleError('El plan de la institución no existe.');
  const { rows: [deployment] } = await pool.query('SELECT * FROM deployments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1', [tenant.id]);
  const { rows: [local] } = await pool.query('SELECT inventory FROM local_inventory WHERE tenant_id=$1', [tenant.id]);
  if (config.PLATFORM_DEPLOY_MODE === 'integration' && (local || deployment?.outputs?.mode === 'local'))
    throw lifecycleError('Este tenant pertenece al simulador. Registra un tenant nuevo para el despliegue real.');
  if (config.PLATFORM_DEPLOY_MODE === 'local' && (operation.params.deployment || deployment && deployment.outputs?.mode !== 'local'))
    throw lifecycleError('Este tenant tiene infraestructura real. Usa una base independiente para la simulación.');
  const previewId = operation.params.preview_id;
  const preview = previewId
    ? (await pool.query("SELECT result FROM operations WHERE id=$1 AND tenant_id=$2 AND status='succeeded'", [previewId, tenant.id])).rows[0]?.result
    : undefined;
  if (previewId && !preview) throw lifecycleError('La vista previa ya no está disponible.');
  if (tenant.status === 'draft' && !deployment && !local) {
    if (operation.type === 'preview-delete') return { result: {
      summary: 'Eliminar el registro del tenant',
      changes: ['Se eliminará el acceso al tenant. El historial se conserva.'],
      downtime: false,
    } };
    if (operation.type === 'delete') return { tenantStatus: 'deleted' };
  }
  const deploymentSnapshot = operation.params.deployment && validateSnapshot(operation.params.deployment, tenant);
  const options = { ...context, tenant, plan, deployment, preview, deploymentSnapshot };
  let outcome;
  if (config.PLATFORM_DEPLOY_MODE === 'local') {
    outcome = await simulate({ ...options, inventory: local?.inventory });
  } else if (tenant.engine === 'cloudformation') {
    const { runCloudFormationLifecycle } = await import('./cloudformation-lifecycle.js');
    outcome = await runCloudFormationLifecycle(options);
  } else {
    const { runTerraformOperation } = await import('./terraform-adapter.js');
    outcome = await runTerraformOperation(options);
  }
  if (operation.type === 'preview-plan') {
    const labels = { max_students: 'estudiantes', max_teachers: 'docentes', max_courses: 'cursos' };
    for (const [key, label] of Object.entries(labels)) {
      const before = tenant.plan_snapshot.limits[key];
      const after = plan.limits[key];
      if (before !== after) outcome.result.changes.push(`Límite de ${label}: ${before ?? '—'} → ${after ?? '—'}`);
    }
    const { backup: previous } = tenant.plan_snapshot;
    const { backup: target } = plan;
    if (previous.schedule !== target.schedule || previous.retention_days !== target.retention_days) {
      const format = ({ schedule, retention_days }) => `${schedule === 'daily' ? 'diario' : 'semanal'} (${retention_days} días)`;
      outcome.result.changes.push(`Respaldo: ${format(previous)} → ${format(target)}`);
    }
  }
  if (operation.type === 'plan-change') outcome.planSnapshot = plan;
  return outcome;
}

export async function persistLifecycle(client, operation, outcome, status) {
  if (status === 'succeeded' && outcome?.deployment) {
    const { ami, outputs, resources, tool_versions, health = outputs.health ?? {} } = outcome.deployment;
    await client.query(
      `INSERT INTO deployments(id,tenant_id,operation_id,engine,ami,outputs,resources,tool_versions,log_ref,status,health)
       SELECT $1,id,$3::uuid,engine,$4,$5,$6::jsonb,$7,'operations/' || ($3::uuid)::text,$8,$9 FROM tenants WHERE id=$2`,
      [randomUUID(), operation.tenant_id, operation.id, ami, outputs, JSON.stringify(resources), tool_versions, outcome.tenantStatus, health],
    );
  }
  if (status === 'succeeded' && outcome?.backupId)
    await client.query('INSERT INTO local_backups(tenant_id,id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [operation.tenant_id, outcome.backupId]);
  if ((status === 'succeeded' || (status === 'failed' && outcome?.failure)) && outcome?.inventory !== undefined) {
    if (outcome.inventory === null)
      await client.query('DELETE FROM local_inventory WHERE tenant_id=$1', [operation.tenant_id]);
    else await client.query(
      'INSERT INTO local_inventory VALUES ($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET inventory=excluded.inventory',
      [operation.tenant_id, outcome.inventory],
    );
  }
  const state = status === 'succeeded' ? outcome?.tenantStatus : operation.type === 'create' ? 'failed' : undefined;
  if (state) {
    const plan = outcome?.planSnapshot ?? null;
    await client.query('UPDATE tenants SET status=$2,plan=COALESCE($3,plan),plan_snapshot=COALESCE($4,plan_snapshot),updated_at=now() WHERE id=$1',
      [operation.tenant_id, state, plan?.code ?? null, plan]);
  }
  if (state === 'deleted') {
    await client.query(`UPDATE deployments SET status='deleted',
      outputs=jsonb_set(outputs,'{urls}','{"frontend":null,"api":null,"frontend_health":null,"backend_health":null}'::jsonb)
      WHERE tenant_id=$1`, [operation.tenant_id]);
    await client.query("UPDATE users SET active=false WHERE tenant_id=$1 AND role='tenant_admin'", [operation.tenant_id]);
    await client.query('DELETE FROM sessions USING users WHERE sessions.user_id=users.id AND users.tenant_id=$1', [operation.tenant_id]);
  }
  if (status !== 'succeeded') await recoverLegacyTransition(client, operation);
}
