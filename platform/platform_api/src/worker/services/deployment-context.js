import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './command-runner.js';
import { OperationCancelled, LeaseLost } from '../errors.js';

export function ensureActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof LeaseLost ? signal.reason : new OperationCancelled();
}

export async function prepareDeploymentContext({ config, tenant, snapshot, operation, signal, report }) {
  const directory = resolve(config.PLATFORM_WORK_ROOT || config.DEPLOYMENT_WORK_DIR || config.IAC_RUNS_DIR,
    tenant.tenant_id, tenant.env, tenant.engine);
  ensureActive(signal);
  const version = snapshot.input.plan_version ? ` v${snapshot.input.plan_version}` : '';
  await report(`Preparando la configuración guardada de la instalación: plan ${snapshot.input.plan}${version}.`, { stage: 'Preparando instalación', progress: 5 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const nativeStack = ['cloudformation', 'pulumi'].includes(snapshot.backend.type);
  const variableFile = nativeStack ? undefined : resolve(directory, 'tenant.tfvars.json');
  const backendFile = nativeStack ? undefined : resolve(directory, 'backend.hcl');
  const cloudInitTemplatePath = config.IAC_CLOUD_INIT_TEMPLATE ?? fileURLToPath(new URL('../../../../../infra/cloud-init/user-data.yaml.tftpl', import.meta.url));
  if (!nativeStack) {
    await writeFile(variableFile, JSON.stringify({ ...snapshot.input, cloud_init_template_path: cloudInitTemplatePath }, null, 2) + '\n', { mode: 0o600 });
    await writeFile(backendFile, Object.entries(snapshot.backend).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  }
  return {
    input: { ...snapshot.input, image: { version: snapshot.image_version, git_commit: snapshot.image_git_commit ?? null } }, backend: snapshot.backend, directory, variableFile, backendFile,
    cloudInitTemplatePath,
    moduleDirectory: config.IAC_MODULE_DIR ?? fileURLToPath(new URL('../../../../../infra/terraform/tenant/', import.meta.url)),
    signal, report, logRef: `operations/${operation.id}`,
    execute: (options) => runCommand({ ...options, cwd: directory, signal,
      env: { ...options.env,
        ...Object.fromEntries(Object.keys(process.env).filter((key) => /^TF_(?:CLI_ARGS|VAR_|WORKSPACE|DATA_DIR)/i.test(key)).map((key) => [key, undefined])),
        TF_WORKSPACE: 'default', TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_DATA_DIR: resolve(directory, '.terraform') },
      onLine: (line, stream) => report(line, { level: stream === 'stderr' ? 'warning' : 'info' }) }),
  };
}
