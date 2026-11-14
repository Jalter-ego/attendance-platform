// Ciclo de vida de un tenant Pulumi (P2, D3) dentro del flujo de P6: suspender, reanudar,
// vista previa de eliminación y eliminar. El create con configuración congelada pasa por
// handlers/create.handler.js con el mismo adaptador.
import { resolve } from 'node:path';
import { createPulumiAdapter } from '../../engines/pulumi.js';
import { buildTenantInput } from '../../engines/tenant-input.js';
import { waitForHealth } from '../../engines/health.js';
import { supportsRealLifecycle } from '../../engines/lifecycle-capabilities.js';
import { OperationError } from '../errors.js';
import { ensureTenantSecrets } from './tenant-secrets.js';
import { checkTenantHealth } from './tenant-health.js';
import { healthUrls, pinDeploymentInput } from './cloudformation-lifecycle.js';

const status = { create: 'ready', resume: 'ready', suspend: 'suspended', delete: 'deleted' };

export async function runPulumiLifecycle({ config, tenant, plan, deployment, deploymentSnapshot, operation, preview, report, signal, creationServices }, {
  makeAdapter = createPulumiAdapter,
  loadInput = buildTenantInput,
  pinInput = pinDeploymentInput,
  prepareSecrets = ensureTenantSecrets,
  checkHealth = waitForHealth,
} = {}) {
  const { type } = operation;
  if (config.PLATFORM_DEPLOY_MODE !== 'integration' || tenant.engine !== 'pulumi' || !supportsRealLifecycle(tenant.engine, type))
    throw new OperationError('IAC_ENGINE_UNSUPPORTED', 'Pulumi no admite esta operación en este entorno.');
  const deadline = AbortSignal.timeout((config.IAC_TIMEOUT_S ?? 3600) * 1000);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    activeSignal.throwIfAborted();
    const input = deploymentSnapshot ? { ...deploymentSnapshot.input, suspended: type === 'suspend',
      image: { version: deploymentSnapshot.image_version, git_commit: deploymentSnapshot.image_git_commit ?? null } } : await loadInput({
      ...config,
      IAC_BASE_OUTPUTS: config.PLATFORM_BASE_OUTPUT_FILE || config.IAC_BASE_OUTPUTS,
      IAC_AMI_IDS: config.PLATFORM_AMI_FILE || config.IAC_AMI_IDS,
    }, tenant, plan, { suspended: type === 'suspend' });
    // Las AMIs y la red del primer despliegue se conservan: suspender no cambia de imagen.
    if (deployment?.ami && Object.keys(deployment.ami).length) {
      input.ami = deployment.ami;
      input.image = { version: deployment.tool_versions?.image_version, git_commit: deployment.tool_versions?.image_git_commit };
    }
    const { ami, image } = await pinInput(config, tenant, input);
    Object.assign(input, { ami, image });

    // Mismo directorio y backend que el create: el stack no se mueve entre reintentos.
    const state = deployment?.outputs?.state;
    const ctx = {
      input, report, signal: activeSignal, logRef: `operations/${operation.id}`,
      directory: resolve(config.PLATFORM_WORK_ROOT || config.IAC_RUNS_DIR, tenant.tenant_id, tenant.env, 'pulumi'),
      backend: state?.backend ? { url: state.backend } : deploymentSnapshot?.backend,
    };
    const adapter = makeAdapter(config);

    if (type === 'preview-delete') {
      const summary = await adapter.preview(ctx, { destroy: true });
      return { result: {
        summary: summary.stack ? 'Eliminar el stack Pulumi del tenant' : 'El stack del tenant ya no existe',
        changes: summary.lines, downtime: summary.lines.length > 0,
        stack: summary.stack, fingerprint: summary.fingerprint,
      } };
    }
    if (type === 'delete' && !/^[a-f0-9]{64}$/.test(preview?.fingerprint ?? ''))
      throw new OperationError('IAC_PREVIEW_REQUIRED', 'Genera una vista previa de Pulumi antes de eliminar.');
    if (type === 'create') {
      await report('Preparando o reutilizando las referencias de secretos en SSM.', { stage: 'Preparando secretos', progress: 8 });
      await prepareSecrets(tenant, { signal: activeSignal, projectName: input.base.project_name });
    }
    const result = type === 'delete'
      ? await adapter.destroy(ctx, { expectedPreview: preview })
      : await adapter[type === 'create' ? 'apply' : type](ctx);

    const tenantStatus = status[type];
    let health = {};
    let deploymentHealth;
    if (tenantStatus === 'ready') {
      await report('Verificando el frontend y la API del tenant.', { stage: 'Comprobando la salud', progress: 85 });
      const targets = healthUrls(result.outputs.urls);
      if (deploymentSnapshot) {
        deploymentHealth = await (creationServices?.checkHealth ?? checkTenantHealth)({
          tenant: input, url: result.outputs.urls.frontend, projectName: input.base.project_name,
          config, signal: activeSignal, report,
        });
        if (deploymentHealth.status !== 'healthy')
          throw new OperationError('TENANT_UNHEALTHY', 'La aplicación todavía no está sana tras reanudar este tenant.');
      } else {
        await checkHealth(targets, {
          timeoutMs: (config.HEALTH_TIMEOUT_S ?? 900) * 1000,
          signal: activeSignal,
          onWait: (pending, elapsed) => report(`Aún arrancando (${elapsed} s): ${pending.join(', ')}.`),
        });
      }
      health = { frontend: 'healthy', backend: 'healthy', database: 'healthy' };
    } else if (tenantStatus === 'suspended') {
      health = { frontend: 'paused', backend: 'paused', database: 'paused' };
    }
    return {
      tenantStatus,
      deployment: {
        ami: tenantStatus === 'deleted' ? {} : input.ami,
        outputs: { ...result.outputs, ...(state ? { state } : {}), health, mode: 'integration' },
        resources: result.resources,
        tool_versions: result.tool_versions,
        health: deploymentHealth,
      },
      result: { stack: result.outputs.stack_name ?? preview?.stack ?? null },
    };
  } catch (error) {
    if (!signal?.aborted && deadline.aborted)
      throw new OperationError('IAC_TIMEOUT', 'Pulumi superó el tiempo máximo. Revisa el stack antes de reintentar.');
    throw error;
  }
}
