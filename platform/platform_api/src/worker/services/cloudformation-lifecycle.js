import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createCloudFormationAdapter } from '../../engines/cloudformation.js';
import { buildTenantInput } from '../../engines/tenant-input.js';
import { waitForHealth } from '../../engines/health.js';
import { supportsRealLifecycle } from '../../engines/lifecycle-capabilities.js';
import { OperationError } from '../errors.js';
import { ensureTenantSecrets } from './tenant-secrets.js';
import { checkTenantHealth } from './tenant-health.js';

const status = { create: 'ready', resume: 'ready', suspend: 'suspended', delete: 'deleted' };

// También lo usa Pulumi (pulumi-lifecycle.js): la ruta incluye el motor del tenant.
export async function pinDeploymentInput(config, tenant, input) {
  const location = resolve(config.PLATFORM_WORK_ROOT || config.IAC_RUNS_DIR, tenant.engine, tenant.id, 'initial-input.json');
  await mkdir(dirname(location), { recursive: true, mode: 0o700 });
  const binding = { project: input.base.project_name, region: input.region, vpc: input.base.vpc_id };
  const pinned = { binding, ami: input.ami, image: input.image };
  try {
    await writeFile(location, JSON.stringify(pinned), { mode: 0o600, flag: 'wx' });
    return pinned;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  try {
    const initial = JSON.parse(await readFile(location, 'utf8'));
    if (Object.entries(binding).every(([key, value]) => initial.binding[key] === value)) return initial;
  } catch {
    throw new OperationError('IAC_CONFIG', 'La configuración fijada del stack no se puede leer.');
  }
  throw new OperationError('IAC_STACK_CHANGED', 'Cambió la red o identidad del stack. Revisa la configuración persistida del tenant.');
}

export function healthUrls(urls) {
  const paths = { frontend: '/healthz', backend: '/core/api/v1/health' };
  const targets = {};
  let origin;
  for (const [service, pathname] of Object.entries(paths)) {
    let url;
    try { url = new URL(urls?.[`${service}_health`]); } catch { /* El error siguiente describe el contrato. */ }
    if (url?.protocol !== 'http:' || !isIP(url.hostname) || url.pathname !== pathname
      || url.port || url.username || url.password || url.search || url.hash || (origin && origin !== url.origin)) {
      throw new OperationError('ENGINE_OUTPUT', 'El stack no devolvió las dos URLs de salud esperadas.');
    }
    origin = url.origin;
    targets[service] = url.href;
  }
  return targets;
}

export async function runCloudFormationLifecycle({ config, tenant, plan, deployment, deploymentSnapshot, operation, preview, report, signal, creationServices }, {
  makeAdapter = createCloudFormationAdapter,
  loadInput = buildTenantInput,
  pinInput = pinDeploymentInput,
  prepareSecrets = ensureTenantSecrets,
  checkHealth = waitForHealth,
} = {}) {
  const { type } = operation;
  if (config.PLATFORM_DEPLOY_MODE !== 'integration' || tenant.engine !== 'cloudformation'
    || !supportsRealLifecycle(tenant.engine, type)) {
    throw new OperationError('IAC_ENGINE_UNSUPPORTED', 'CloudFormation no admite esta operación en este entorno.');
  }
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
    if (deployment?.ami && Object.keys(deployment.ami).length) {
      input.ami = deployment.ami;
      input.image = { version: deployment.tool_versions?.image_version, git_commit: deployment.tool_versions?.image_git_commit };
    }
    const { ami, image } = await pinInput(config, tenant, input);
    Object.assign(input, { ami, image });
    const adapter = makeAdapter(config);
    const ctx = {
      input, report, signal: activeSignal, logRef: `operations/${operation.id}`,
      deployedStackId: deployment?.outputs?.stack_id, enforceStackOwnership: true,
    };
    if (type === 'preview-delete') {
      const summary = await adapter.preview(ctx, { destroy: true });
      return { result: {
        summary: summary.stack_id ? 'Eliminar el stack CloudFormation del tenant' : 'El stack del tenant ya no existe',
        changes: summary.lines, downtime: summary.lines.length > 0,
        stack_id: summary.stack_id, fingerprint: summary.fingerprint,
      } };
    }
    if (type === 'delete' && (!/^[a-f0-9]{64}$/.test(preview?.fingerprint ?? '')
      || !(preview.stack_id === null || typeof preview.stack_id === 'string'))) {
      throw new OperationError('IAC_PREVIEW_REQUIRED', 'Genera una vista previa de CloudFormation antes de eliminar.');
    }
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
      healthUrls(result.outputs.urls);
      if (deploymentSnapshot) {
        deploymentHealth = await (creationServices?.checkHealth ?? checkTenantHealth)({
          tenant: input, url: result.outputs.urls.frontend, projectName: input.base.project_name,
          config, signal: activeSignal, report,
        });
        if (deploymentHealth.status !== 'healthy')
          throw new OperationError('TENANT_UNHEALTHY', 'La aplicación todavía no está sana tras reanudar este tenant.');
      } else {
        await checkHealth(healthUrls(result.outputs.urls), {
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
        outputs: { ...result.outputs, health, mode: 'integration' },
        resources: result.resources,
        tool_versions: result.tool_versions,
        health: deploymentHealth,
      },
      result: { stack_id: result.outputs.stack_id ?? preview?.stack_id ?? null },
    };
  } catch (error) {
    if (!signal?.aborted && deadline.aborted)
      throw new OperationError('IAC_TIMEOUT', 'CloudFormation superó el tiempo máximo. Revisa el estado del stack antes de reintentar.');
    throw error;
  }
}
