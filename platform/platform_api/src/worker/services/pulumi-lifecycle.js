import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { createPulumiAdapter } from '../../engines/pulumi.js';
import { buildTenantInput } from '../../engines/tenant-input.js';
import { waitForHealth } from '../../engines/health.js';
import { OperationError } from '../errors.js';
import { ensureTenantSecrets } from './tenant-secrets.js';
import { checkTenantHealth } from './tenant-health.js';
import { prepareDeploymentContext } from './deployment-context.js';

async function pinInput(config, tenant, input, backend) {
  const location = resolve(config.PLATFORM_WORK_ROOT || config.IAC_RUNS_DIR, 'pulumi', tenant.id, 'initial-input.json');
  await mkdir(dirname(location), { recursive: true, mode: 0o700 });
  const record = { input, backend };
  try { await writeFile(location, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); return record; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let existing;
  try { existing = JSON.parse(await readFile(location, 'utf8')); }
  catch { throw new OperationError('IAC_CONFIG', 'No se puede leer la configuración fijada del tenant Pulumi.'); }
  if (existing.input.tenant_id !== tenant.tenant_id || existing.input.env !== tenant.env ||
    !['type', 'region', 'bucket', 'url', 'stack_name'].every(key => existing.backend?.[key] === backend[key]))
    throw new OperationError('IAC_STACK_CHANGED', 'Cambió la identidad del backend Pulumi. Revisa la instalación guardada del tenant.');
  // Keep original AMIs, sizing, plan and boot identity on retry/suspend/resume.
  return existing;
}

function healthUrls(urls) {
  const targets = {};
  let origin;
  for (const [key, path] of [['frontend', '/healthz'], ['backend', '/core/api/v1/health']]) {
    let url; try { url = new URL(urls?.[`${key}_health`]); } catch { /* validation below */ }
    if (!url || url.protocol !== 'http:' || !isIP(url.hostname) || url.pathname !== path ||
      url.port || url.username || url.password || url.search || url.hash || (origin && origin !== url.origin))
      throw new OperationError('ENGINE_OUTPUT', 'Pulumi no devolvió las URLs de salud esperadas.');
    origin = url.origin;
    targets[key] = url.href;
  }
  return targets;
}

export async function runPulumiLifecycle({ config, tenant, plan, deployment, deploymentSnapshot, operation, preview,
  report, signal, creationServices }, {
  makeAdapter = createPulumiAdapter, loadInput = buildTenantInput, pin = pinInput,
  prepareSecrets = ensureTenantSecrets, checkHealth = waitForHealth, prepareContext = prepareDeploymentContext,
} = {}) {
  const type = operation.type;
  if (config.PLATFORM_DEPLOY_MODE !== 'integration' || tenant.engine !== 'pulumi' ||
    !['create', 'suspend', 'resume', 'preview-delete', 'delete'].includes(type))
    throw new OperationError('IAC_ENGINE_UNSUPPORTED', 'Pulumi admite crear, suspender, reanudar y eliminar con vista previa.');
  const deadline = AbortSignal.timeout((config.IAC_TIMEOUT_S ?? 3600) * 1000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    active.throwIfAborted();
    let input = deploymentSnapshot ? { ...deploymentSnapshot.input, image: {
      version: deploymentSnapshot.image_version, git_commit: deploymentSnapshot.image_git_commit ?? null,
    } } : await loadInput({ ...config, IAC_BASE_OUTPUTS: config.PLATFORM_BASE_OUTPUT_FILE || config.IAC_BASE_OUTPUTS,
      IAC_AMI_IDS: config.PLATFORM_AMI_FILE || config.IAC_AMI_IDS }, tenant, plan, { suspended: type === 'suspend' });
    const backend = deploymentSnapshot?.backend ?? {
      type: 'pulumi', region: input.base.region, bucket: config.IAC_STATE_BUCKET,
      url: config.PULUMI_BACKEND_URL || `s3://${config.IAC_STATE_BUCKET}/pulumi`,
      stack_name: `${input.base.project_name}-${input.tenant_id}-${input.env}`,
    };
    const pinned = await pin(config, tenant, input, backend);
    input = { ...pinned.input, suspended: type === 'suspend' };
    const ctx = await prepareContext({ config, tenant, snapshot: { ...deploymentSnapshot, input, backend: pinned.backend,
      image_version: input.image?.version, image_git_commit: input.image?.git_commit }, operation, signal: active, report });
    if (deployment?.outputs?.stack_name && deployment.outputs.stack_name !== ctx.backend.stack_name)
      throw new OperationError('IAC_STACK_CHANGED', 'El stack Pulumi guardado no coincide con la instalación.');
    const adapter = makeAdapter(config);
    if (type === 'preview-delete') {
      const summary = await adapter.preview(ctx, { destroy: true });
      return { result: { summary: 'Eliminar los recursos Pulumi del tenant', changes: summary.lines,
        downtime: summary.lines.length > 0, stack_name: summary.stack_name, fingerprint: summary.fingerprint } };
    }
    if (type === 'delete' && (!/^[a-f0-9]{64}$/.test(preview?.fingerprint ?? '') || preview.stack_name !== backend.stack_name))
      throw new OperationError('IAC_PREVIEW_REQUIRED', 'Genera una vista previa Pulumi antes de eliminar.');
    await adapter.preflight(ctx);
    if (type === 'create') await prepareSecrets(tenant, { signal: active, projectName: input.base.project_name });
    const result = type === 'delete' ? await adapter.destroy(ctx, { expectedPreview: preview })
      : await adapter[type === 'create' ? 'apply' : type](ctx);
    const tenantStatus = type === 'delete' ? 'deleted' : type === 'suspend' ? 'suspended' : 'ready';
    let health = {};
    let deploymentHealth;
    if (tenantStatus === 'ready') {
      const targets = healthUrls(result.outputs.urls);
      await report('Comprobando frontend, API y base de datos.', { stage: 'Comprobando la salud', progress: 85 });
      if (deploymentSnapshot) {
        deploymentHealth = await (creationServices?.checkHealth ?? checkTenantHealth)({
          tenant: input, url: result.outputs.urls.frontend, projectName: input.base.project_name, config, signal: active, report,
        });
        if (deploymentHealth.status !== 'healthy') throw new OperationError('TENANT_UNHEALTHY', 'La aplicación Pulumi todavía no está sana.');
      } else await checkHealth(targets, { timeoutMs: (config.HEALTH_TIMEOUT_S ?? 900) * 1000, signal: active,
        onWait: (pending, elapsed) => report(`Aún arrancando (${elapsed} s): ${pending.join(', ')}.`) });
      health = { frontend: 'healthy', backend: 'healthy', database: 'healthy' };
    } else if (tenantStatus === 'suspended') health = { frontend: 'paused', backend: 'paused', database: 'paused' };
    return { tenantStatus, deployment: { ami: tenantStatus === 'deleted' ? {} : input.ami,
      outputs: { ...result.outputs, health, mode: 'integration' }, resources: result.resources,
      tool_versions: result.tool_versions, health: deploymentHealth },
      result: { stack_name: ctx.backend.stack_name } };
  } catch (error) {
    if (!signal?.aborted && deadline.aborted)
      throw new OperationError('IAC_TIMEOUT', 'Pulumi superó el tiempo máximo. Revisa el bloqueo y estado del stack antes de reintentar.');
    throw error;
  }
}
