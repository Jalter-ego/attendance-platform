import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportsTerraformLifecycle } from '../../engines/lifecycle-capabilities.js';
import { BACKUP_BY_PLAN } from '../../engines/tenant-input.js';
import { runCommand } from './command-runner.js';
import { ensureTenantSecrets } from './tenant-secrets.js';
import { OperationError } from '../errors.js';

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const roles = ['frontend', 'backend', 'db'];
const backendKeys = ['project_name', 'region', 'availability_zone', 'vpc_id', 'public_subnet_id',
  'private_subnet_id', 'monitoring_security_group_id', 'ssm_endpoint_id', 'backups_bucket'];
const paths = { frontend: '/', api: '/core/api/v1', frontend_health: '/healthz', backend_health: '/core/api/v1/health' };
const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const amiPattern = /^ami-[a-f0-9]{17}$/;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const instancePattern = /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const defaultBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';

function requireValue(condition, code, message) {
  if (!condition) throw new OperationError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function parseJson(text, code, message) {
  try { return JSON.parse(text?.replace(/^\uFEFF/, '')); }
  catch { throw new OperationError(code, message); }
}

async function loadJson(file, label) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new OperationError('IAC_CONFIG', `No se pudo leer ${label}.`); }
  return parseJson(text, 'IAC_CONFIG', `El archivo de ${label} no contiene JSON válido.`);
}

function checkIdentity(tenant) {
  requireValue(supportsTerraformLifecycle(tenant.engine), 'IAC_ENGINE_UNSUPPORTED',
    'El despliegue real admite Terraform y OpenTofu. Selecciona uno de esos motores.');
  requireValue(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(tenant.id ?? '')
    && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(tenant.tenant_id)
    && ['test', 'prod'].includes(tenant.env) && regionPattern.test(tenant.region),
  'IAC_CONFIG', 'El identificador, entorno o región de la institución no es válido.');
}

async function configFor(config, tenant, repoRoot, snapshot) {
  const baseFile = config.PLATFORM_BASE_OUTPUT_FILE || config.IAC_BASE_OUTPUTS;
  const bucket = snapshot?.backend.bucket ?? (config.PLATFORM_STATE_BUCKET || config.IAC_STATE_BUCKET);
  requireValue((snapshot || baseFile) && bucketPattern.test(bucket ?? ''), 'IAC_CONFIG',
    'Configura los outputs de la base y el bucket de estado del equipo para el entorno de integración.');
  const input = snapshot?.input.base ?? await loadJson(resolve(repoRoot, baseFile), 'la red base');
  const fullBase = input?.integration?.value ?? input;
  const base = Object.fromEntries(backendKeys.map((key) => [key, fullBase?.[key]]));
  requireValue(
    /^[a-z][a-z0-9-]{2,39}$/.test(base.project_name ?? '')
      && base.region === tenant.region && new RegExp(`^${tenant.region}[a-z]$`).test(base.availability_zone ?? '')
      && /^vpc-[a-f0-9]+$/.test(base.vpc_id ?? '') && /^subnet-[a-f0-9]+$/.test(base.public_subnet_id ?? '')
      && /^subnet-[a-f0-9]+$/.test(base.private_subnet_id ?? '') && base.public_subnet_id !== base.private_subnet_id
      && /^sg-[a-f0-9]+$/.test(base.monitoring_security_group_id ?? '') && /^vpce-[a-f0-9]+$/.test(base.ssm_endpoint_id ?? '')
      && (!base.backups_bucket || bucketPattern.test(base.backups_bucket)),
    'IAC_CONFIG', 'La salida de la red base está incompleta o corresponde a otra región.');
  const stateRegion = snapshot?.backend.region ?? (config.PLATFORM_STATE_REGION || tenant.region);
  requireValue(regionPattern.test(stateRegion), 'IAC_CONFIG', 'La región del bucket de estado no es válida.');
  const binding = {
    tenant: tenant.id,
    engine: tenant.engine,
    bucket,
    region: stateRegion,
    key: `tenants/${tenant.tenant_id}/${tenant.env}/terraform.tfstate`,
  };
  const workRoot = resolve(repoRoot, config.PLATFORM_WORK_ROOT || '.local/platform-iac');
  return { base, binding, directory: join(workRoot, tenant.env, `tenant-${tenant.tenant_id}`) };
}

async function writeOnce(file, value) {
  try {
    await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return value;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadJson(file, 'la configuración ya fijada del tenant');
  }
}

function amiIds(source) {
  const ids = Object.fromEntries(roles.map((role) => [role, source?.[role]]));
  requireValue(Object.values(ids).every((id) => amiPattern.test(id ?? '') && id !== 'ami-00000000000000000'),
    'IAC_CONFIG', 'Se necesitan AMIs vigentes para frontend, backend y base de datos.');
  return ids;
}

async function initialImage(config, tenant, repoRoot) {
  const manifest = await loadJson(resolve(repoRoot, config.PLATFORM_AMI_FILE || config.IAC_AMI_IDS || 'infra/packer/ami-ids.json'), 'las AMIs');
  requireValue(manifest?.region === tenant.region && versionPattern.test(manifest.image_version ?? ''),
    'IAC_CONFIG', 'Las AMIs configuradas no corresponden a la región del tenant o carecen de versión.');
  return { ami: amiIds(manifest.ami), imageVersion: manifest.image_version };
}

async function imageFor({ config, tenant, operation, deployment, deploymentSnapshot, directory, repoRoot }) {
  if (operation.type === 'upgrade') {
    const image = await initialImage(config, tenant, repoRoot);
    requireValue(operation.params.version === image.imageVersion, 'IAC_VERSION_NOT_FOUND',
      'La versión solicitada no coincide con las AMIs publicadas para el despliegue.');
    return image;
  }
  if (deployment?.ami && Object.keys(deployment.ami).length) {
    return { ami: amiIds(deployment.ami),
      imageVersion: deployment.tool_versions?.infrastructure ?? deployment.tool_versions?.image_version ?? deploymentSnapshot?.image_version };
  }
  if (deploymentSnapshot) return { ami: amiIds(deploymentSnapshot.input.ami), imageVersion: deploymentSnapshot.image_version };
  const file = join(directory, 'initial-image.json');
  let image;
  try {
    image = parseJson(await readFile(file, 'utf8'), 'IAC_CONFIG', 'La configuración de AMIs del tenant no se puede leer.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    image = await writeOnce(file, await initialImage(config, tenant, repoRoot));
  }
  return { ami: amiIds(image?.ami), imageVersion: image?.imageVersion };
}

function variablesFor(context, base, image) {
  const { tenant, operation, plan, deployment } = context;
  const sizing = Object.fromEntries([...roles, 'db_disk_gb'].map((key) => [key, plan?.sizing?.[key]]));
  const backup = plan?.backup ?? BACKUP_BY_PLAN[plan?.code];
  const allowableBackup = Object.values(BACKUP_BY_PLAN).some(({ schedule, retention_days }) =>
    backup?.schedule === schedule && backup?.retention_days === retention_days);
  requireValue(roles.every((role) => /^t3\.(?:micro|small|medium|large)$/.test(sizing[role] ?? ''))
    && Number.isSafeInteger(sizing.db_disk_gb) && sizing.db_disk_gb >= 10
    && /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(plan?.code ?? '') && allowableBackup,
  'IAC_CONFIG', 'El plan contiene un tamaño, código o respaldo que no admite el módulo de infraestructura.');
  const planChange = ['plan-change', 'preview-plan'].includes(operation.type);
  requireValue(!planChange || sizing.db_disk_gb >= (deployment?.outputs?.sizing?.db_disk_gb ?? 0), 'IAC_DISK_SHRINK',
    'El plan solicitado reduce el EBS existente. Usa un plan que conserve el tamaño del disco de datos.');
  const suspended = operation.type === 'suspend'
    || (['preview-delete', 'delete'].includes(operation.type)
      && (tenant.status === 'suspended' || deployment?.outputs?.suspended === true));
  const limits = Object.fromEntries(['max_students', 'max_teachers', 'max_courses']
    .filter((field) => Number.isSafeInteger(plan.limits?.[field]) && plan.limits[field] > 0)
    .map((field) => [field, plan.limits[field]]));
  return {
    base, sizing, limits, suspended,
    tenant_id: tenant.tenant_id, env: tenant.env, name: tenant.name, contact_email: tenant.contact_email,
    timezone: tenant.timezone, engine: tenant.engine, plan: plan.code, ami: image.ami,
    cloud_init_template_path: 'user-data.yaml.tftpl',
    backup,
  };
}

function terraformEnv() {
  const extra = Object.fromEntries(Object.keys(process.env)
    .filter((name) => /^TF_(?:CLI_ARGS|VAR_|WORKSPACE|DATA_DIR)/i.test(name))
    .map((name) => [name, undefined]));
  return { ...extra, TF_WORKSPACE: 'default', TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' };
}

function publicTerraformProgress(line) {
  // Terraform puede imprimir valores privados en diagnósticos y planes.
  // Solo retransmitimos las marcas de progreso, sin los valores de atributos.
  const message = line.match(/^([\w.-]+(?:\["[\w-]+"\])?: (?:Creating|Creation complete|Modifying|Modifications complete|Destroying|Destruction complete|Still creating|Still modifying|Still destroying|Refreshing state))/);
  return message?.[1] ?? line.match(/^(Plan: \d+ to add, \d+ to change, \d+ to destroy\.)/)?.[1];
}

async function prepareDirectory(directory, tenantDirectory, repoRoot, config) {
  const source = resolve(repoRoot, config.IAC_MODULE_DIR || 'infra/terraform/tenant');
  const names = (await readdir(source, { withFileTypes: true }))
    .filter((file) => file.isFile() && /^[\w-]+\.tf$/.test(file.name))
    .map(({ name }) => name).sort();
  requireValue(names.includes('backend.tf'), 'IAC_CONFIG', 'Falta el módulo de tenant de Terraform.');
  const hashes = {};
  for (const name of names) {
    await copyFile(join(source, name), join(directory, name));
    hashes[name] = await readFile(join(directory, name), 'utf8');
  }
  const lockName = '.terraform.lock.hcl';
  for (const path of [tenantDirectory, source]) {
    try {
      await copyFile(join(path, lockName), join(directory, lockName));
      return { hashes, locked: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { hashes, locked: false };
}

function reviewPlan(data, variables, binding, moduleHash, versions) {
  requireValue(/^1\./.test(data?.format_version ?? '') && !data.errored && data.complete !== false
    && (Array.isArray(data.resource_changes) || (data.resource_changes === undefined && data.planned_values)),
  'IAC_PLAN_INVALID', 'El motor no devolvió un plan completo y compatible.');
  const allChanges = data.resource_changes ?? [];
  requireValue(allChanges.every((resource) => Array.isArray(resource.change?.actions)
    && /^[a-zA-Z0-9_."[\]-]+$/.test(resource.address ?? '') && /^[a-zA-Z0-9_]+$/.test(resource.type ?? '')),
  'IAC_PLAN_INVALID', 'El plan contiene recursos o acciones no reconocidos.');
  const changes = allChanges.filter((resource) => resource.mode !== 'data'
    && resource.change.actions.some((action) => action !== 'no-op' && action !== 'read'));
  const labels = { create: 'Crear', update: 'Modificar', delete: 'Eliminar', 'create,delete': 'Reemplazar', 'delete,create': 'Reemplazar' };
  requireValue(changes.every(({ change }) => Object.hasOwn(labels, change.actions.join(',')))
    && !(changes.length > 0 && data.applyable === false),
  'IAC_PLAN_INVALID', 'El plan contiene cambios que no pueden aplicarse desde la plataforma.');
  const describe = (resource) => {
    if (resource.type === 'aws_ebs_volume') return `${resource.address} (disco de datos PostgreSQL)`;
    if (resource.type === 'aws_instance') return `${resource.address} (máquina EC2)`;
    return resource.address;
  };
  return {
    changes,
    needsApply: changes.length > 0 || data.applyable === true
      || Object.values(data.output_changes ?? {}).some(({ actions }) => actions?.some((action) => action !== 'no-op')),
    result: {
      summary: changes.length ? `${changes.length} cambios de infraestructura` : 'Sin cambios de infraestructura',
      changes: changes.map((resource) => `${labels[resource.change.actions.join(',')]} ${describe(resource)}`),
      downtime: changes.some(({ type }) => ['aws_instance', 'aws_ec2_instance_state', 'aws_ebs_volume', 'aws_volume_attachment'].includes(type)),
      plan_digest: digest({ binding, variables, moduleHash, versions,
        changes: changes.toSorted((a, b) => a.address.localeCompare(b.address)),
        outputs: data.output_changes,
      }),
    },
  };
}

function forbidDataLoss(changes, operation) {
  if (['delete', 'preview-delete'].includes(operation.type)) return;
  for (const { type, change } of changes) {
    if (type === 'aws_ebs_volume') {
      requireValue(!change.actions.includes('delete')
        && !(Number.isFinite(change.before?.size) && change.after?.size < change.before.size),
      'IAC_DISK_DESTRUCTIVE', 'El plan reduciría, reemplazaría o eliminaría el disco de datos. Se requiere una migración explícita.');
    }
    if (['suspend', 'resume'].includes(operation.type) && ['aws_instance', 'aws_volume_attachment'].includes(type)) {
      requireValue(!change.actions.some((action) => action === 'delete' || action === 'create'), 'IAC_POWER_PLAN_UNSAFE',
        'El plan de encendido o suspensión cambiaría las máquinas o su disco. Revisa el estado antes de continuar.');
    }
  }
}

function safeOutput(data, key) {
  const output = data?.[key];
  return output && output.sensitive === false ? output.value : undefined;
}

function httpUrls(raw, suspended) {
  if (suspended) return Object.fromEntries(Object.keys(paths).map((key) => [key, null]));
  const urls = {};
  let origin;
  for (const [key, path] of Object.entries(paths)) {
    let url;
    try { url = new URL(raw?.[key]); } catch { /* Error de contrato sin mostrar datos privados. */ }
    requireValue(url?.protocol === 'http:' && isIP(url.hostname) === 4 && url.port === ''
      && url.pathname === path && !url.search && !url.hash && !url.username && !url.password
      && (!origin || origin === url.origin), 'IAC_OUTPUT_INVALID', 'La infraestructura no devolvió URLs válidas para verificar el tenant.');
    origin = url.origin;
    urls[key] = url.href;
  }
  return urls;
}

function privateOutputs(data, variables) {
  const instanceIds = safeOutput(data, 'instance_ids');
  const ips = safeOutput(data, 'private_ips');
  const dbVolumeId = safeOutput(data, 'db_volume_id');
  requireValue(roles.every((role) => instancePattern.test(instanceIds?.[role] ?? '') && isIP(ips?.[role] ?? '') === 4)
    && /^vol-[a-f0-9]+$/.test(dbVolumeId ?? '')
    && safeOutput(data, 'suspended') === variables.suspended, 'IAC_OUTPUT_INVALID',
  'El motor no devolvió los identificadores y el estado esperados del tenant.');
  return {
    instance_ids: Object.fromEntries(roles.map((role) => [role, instanceIds[role]])),
    private_ips: Object.fromEntries(roles.map((role) => [role, ips[role]])),
    db_volume_id: dbVolumeId, suspended: variables.suspended, sizing: variables.sizing,
    urls: httpUrls(safeOutput(data, 'urls'), variables.suspended),
  };
}

const parseLastLine = (stdout) => parseJson(stdout?.trim().split(/\r?\n/).at(-1), 'IAC_SCRIPT_OUTPUT',
  'El script no devolvió un resultado JSON válido.');

async function verifyHealth({ run, config, tenant, base, repoRoot, urls, instances, signal, report }) {
  const timeout = config.HEALTH_TIMEOUT_S ?? 300;
  await report('Verificando el frontend, la API y la base de datos del tenant.', { stage: 'Verificando salud', progress: 88 });
  const reply = await run({
    command: config.BACKUP_BASH || defaultBash, cwd: repoRoot, signal,
    args: [(config.HEALTH_SCRIPT || join(repoRoot, 'infra', 'health', 'tenant-health.sh')).replaceAll('\\', '/'), '--tenant', tenant.tenant_id, '--env', tenant.env,
      '--region', tenant.region, '--project', base.project_name, '--url', urls.frontend, '--timeout', String(timeout), '--boot'],
    env: { MSYS_NO_PATHCONV: '1', AWS_CLI_OUTPUT_ENCODING: 'UTF-8' },
    acceptedExitCodes: [0, 1], timeoutMs: (timeout + 220) * 1000, captureStdout: true, logStdout: false,
  });
  requireValue(reply.exitCode === 0, 'IAC_UNHEALTHY',
    'La infraestructura fue aplicada, pero la aplicación aún no responde correctamente. Reintenta sobre el mismo estado.');
  const outcome = parseLastLine(reply.stdout);
  requireValue(outcome?.tenant === tenant.tenant_id && outcome.env === tenant.env
    && outcome.status === 'healthy' && outcome.checks?.frontend?.status === 200 && outcome.checks?.backend?.status === 200,
  'IAC_UNHEALTHY', 'La infraestructura fue aplicada, pero la aplicación aún no responde correctamente. Reintenta sobre el mismo estado.');
  const appVersions = {};
  for (const role of ['frontend', 'backend']) {
    const node = Array.isArray(outcome.boot) ? outcome.boot.find((item) =>
      item?.role === role && item.instance_id === instances?.[role] &&
      item.boot?.tenant_id === tenant.tenant_id && item.boot?.env === tenant.env && item.boot?.status === 'ready') : null;
    const version = node?.boot?.app_version;
    if (/^(?:[a-f0-9]{12}|[a-f0-9]{40})$/.test(version ?? '')) appVersions[role] = version;
  }
  if (Object.keys(appVersions).length < 2)
    await report('La aplicación responde. Algunas versiones instaladas todavía no se pudieron verificar por SSM.', { level: 'warning' });
  return { health: { frontend: 'healthy', backend: 'healthy', database: 'healthy' }, appVersions, deploymentHealth: {
    status: 'healthy',
    checks: Object.fromEntries(['frontend', 'backend'].map((key) => [
      key, { status: outcome.checks[key].status, ms: Number.isSafeInteger(outcome.checks[key].ms) ? outcome.checks[key].ms : 0 },
    ])),
  } };
}

function toolVersions(detail, engine, deployment, image, operation) {
  const cliVersion = detail?.tofu_version ?? detail?.terraform_version;
  const provider = detail?.provider_selections?.['registry.terraform.io/hashicorp/aws'];
  const versions = {
    [engine]: versionPattern.test(cliVersion ?? '') ? cliVersion : engine,
    ...(versionPattern.test(provider ?? '') && { provider_aws: provider }),
    ...(versionPattern.test(image.imageVersion ?? '') && { infrastructure: image.imageVersion }),
  };
  // Una nueva AMI puede reemplazar las instancias y sus versiones instaladas.
  // En un cambio sin reemplazo, las versiones SSM siguen siendo las anteriores.
  const updatedApp = knownAppVersions(deployment);
  if (operation.type !== 'upgrade' && Object.keys(updatedApp).length) versions.app = updatedApp;
  return versions;
}

function knownAppVersions(deployment) {
  return Object.fromEntries(['frontend', 'backend'].filter((role) =>
    /^(?:[a-f0-9]{12}|[a-f0-9]{40})$/.test(deployment?.tool_versions?.app?.[role] ?? ''))
    .map((role) => [role, deployment.tool_versions.app[role]]));
}

async function updateApp(context, { base, repoRoot, run }) {
  const { config, tenant, operation, deployment, report, signal } = context;
  const { component = 'backend', version } = operation.params ?? {};
  requireValue(['backend', 'frontend'].includes(component) && /^[a-f0-9]{12}$/.test(version ?? ''),
    'IAC_RELEASE_INVALID', 'Selecciona frontend o backend e indica el SHA de 12 caracteres de un paquete publicado.');
  const instance = deployment?.outputs?.instance_ids?.[component];
  requireValue(instancePattern.test(instance ?? '') && bucketPattern.test(base.backups_bucket ?? ''), 'IAC_RELEASE_INVALID',
    'El tenant no tiene un destino de actualización o bucket de versiones registrado.');
  const urls = httpUrls(deployment.outputs.urls, false);
  await report('Verificando la instancia de destino de la actualización.', { stage: 'Validando actualización', progress: 20 });
  const matches = await run({
    command: 'aws', cwd: repoRoot, signal, timeoutMs: 30000, captureStdout: true, logStdout: false,
    args: ['ec2', 'describe-instances', '--region', tenant.region, '--filters',
      `Name=tag:Project,Values=${base.project_name}`, `Name=tag:Tenant,Values=${tenant.tenant_id}`,
      `Name=tag:Env,Values=${tenant.env}`, `Name=tag:Role,Values=${component}`, 'Name=instance-state-name,Values=running',
      '--query', 'Reservations[].Instances[].InstanceId', '--output', 'json'],
  });
  const ids = parseJson(matches.stdout, 'IAC_RELEASE_INVALID', 'No se pudo verificar el destino de la actualización.');
  requireValue(Array.isArray(ids) && ids.length === 1 && ids[0] === instance,
    'IAC_RELEASE_INVALID', 'La instancia activa no coincide con el despliegue registrado.');
  await report('Aplicando el paquete publicado mediante SSM.', { stage: 'Actualizando aplicación', progress: 45 });
  const reply = await run({
    command: config.BACKUP_BASH || defaultBash, cwd: repoRoot, signal, timeoutMs: 660000,
    captureStdout: true, logStdout: false, acceptedExitCodes: [0, 1],
    args: [join(repoRoot, 'infra', 'app-update', 'tenant-update.sh'), 'apply',
      '--tenant', tenant.tenant_id, '--env', tenant.env, '--component', component, '--version', version,
      '--region', tenant.region, '--project', base.project_name, '--bucket', base.backups_bucket],
  });
  const updated = parseLastLine(reply.stdout);
  requireValue(reply.exitCode === 0 && updated?.status === 'succeeded' && updated.instance_id === instance
    && updated.tenant === tenant.tenant_id && updated.env === tenant.env && updated.component === component && updated.to === version,
  'IAC_RELEASE_FAILED', updated?.status === 'rolled_back'
    ? 'El paquete falló y Ansible restauró la versión anterior.'
    : 'No se pudo confirmar la actualización. Comprueba que el paquete esté publicado y revisa la salud del tenant.');
  const { health, appVersions, deploymentHealth } = await verifyHealth({ run, config, tenant, base, repoRoot, urls, instances: deployment.outputs.instance_ids, signal, report });
  return {
    tenantStatus: 'ready',
    deployment: {
      ami: amiIds(deployment.ami), outputs: { ...deployment.outputs, urls, health },
      resources: deployment.resources, health: deploymentHealth,
      tool_versions: { ...deployment.tool_versions, app: { ...knownAppVersions(deployment), ...appVersions, [component]: version } },
    },
    result: { component, version, instance_id: instance },
  };
}

export async function runTerraformOperation(context, {
  repoRoot = repositoryRoot, run = runCommand, prepareSecrets = ensureTenantSecrets,
} = {}) {
  const { config, tenant, operation, deployment, deploymentSnapshot, preview, report, signal } = context;
  requireValue(config.PLATFORM_DEPLOY_MODE === 'integration', 'IAC_MODE', 'El adaptador AWS requiere modo de integración.');
  signal?.throwIfAborted();
  checkIdentity(tenant);
  const { base, binding, directory } = await configFor(config, tenant, repoRoot, deploymentSnapshot);
  const boundState = deployment?.outputs?.state;
  requireValue(!boundState || digest(boundState) === digest(binding), 'IAC_STATE_CHANGED',
    'La configuración del backend cambió desde el último despliegue. Conserva el estado antes de continuar.');
  if (operation.type === 'upgrade' && operation.params?.scope === 'app') {
    return updateApp(context, { base, repoRoot, run });
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storedBinding = await writeOnce(join(directory, 'state-binding.json'), binding);
  requireValue(digest(storedBinding) === digest(binding), 'IAC_STATE_CHANGED',
    'La región, motor o bucket del estado del tenant cambió. Restaura la configuración original o migra el estado.');
  const image = await imageFor({ config, tenant, operation, deployment, deploymentSnapshot, directory, repoRoot });
  const vars = variablesFor(context, base, image);
  const cwd = await mkdtemp(join(directory, 'operation-'));
  try {
    const { hashes, locked } = await prepareDirectory(cwd, directory, repoRoot, config);
    const template = await readFile(resolve(repoRoot, config.IAC_CLOUD_INIT_TEMPLATE || 'infra/cloud-init/user-data.yaml.tftpl'), 'utf8');
    await writeFile(join(cwd, vars.cloud_init_template_path), template, { mode: 0o600 });
    await writeFile(join(cwd, 'tenant.tfvars.json'), JSON.stringify(vars), { mode: 0o600 });
    const backend = { bucket: binding.bucket, region: binding.region, key: binding.key, encrypt: true, use_lockfile: true };
    await writeFile(join(cwd, 'tenant.backend.hcl'), Object.entries(backend)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(''), { mode: 0o600 });
    const binary = (tenant.engine === 'tofu' ? config.TOFU_BIN : config.TERRAFORM_BIN) || tenant.engine;
    const script = /\.m?js$/i.test(binary);
    const cli = (args, options = {}) => run({
      command: script ? process.execPath : binary,
      args: script ? [binary, ...args] : args, cwd, signal, env: terraformEnv(), timeoutMs: (config.IAC_TIMEOUT_S ?? 3600) * 1000,
      onLine: async (line) => {
        const progress = publicTerraformProgress(line);
        if (progress) await report(progress);
      },
      ...options,
    });
    await report('Inicializando el backend S3 del tenant con bloqueo de estado.', { stage: 'Inicializando IaC', progress: 15 });
    await cli(['init', '-input=false', '-no-color', '-lock-timeout=5m',
      ...(locked ? ['-lockfile=readonly'] : []), '-backend-config=tenant.backend.hcl']);
    const lockPath = join(cwd, '.terraform.lock.hcl');
    const lock = await readFile(lockPath, 'utf8');
    await copyFile(lockPath, join(directory, '.terraform.lock.hcl'));
    const moduleHash = digest({ hashes, template, lock });
    const version = await cli(['version', '-json'], { captureStdout: true });
    const versions = parseJson(version.stdout, 'IAC_OUTPUT_INVALID', 'No se pudo leer la versión del motor.');
    const destroying = ['delete', 'preview-delete'].includes(operation.type);
    const previewing = ['preview-plan', 'preview-delete'].includes(operation.type);
    await report('Comparando la configuración con el estado actual.', { stage: 'Planificando cambios', progress: 35 });
    await cli(['plan', ...(destroying ? ['-destroy'] : []), '-input=false', '-no-color', '-lock-timeout=5m',
      '-var-file=tenant.tfvars.json', '-out=review.tfplan', '-detailed-exitcode'], { acceptedExitCodes: [0, 2] });
    const showed = await cli(['show', '-json', 'review.tfplan'], { captureStdout: true });
    const reviewed = reviewPlan(parseJson(showed.stdout, 'IAC_PLAN_INVALID', 'El plan de infraestructura no se puede leer.'), vars, binding, moduleHash, versions);
    forbidDataLoss(reviewed.changes, operation);
    if (previewing) return { result: reviewed.result };
    if (destroying || operation.type === 'plan-change') {
      requireValue(preview?.plan_digest === reviewed.result.plan_digest, 'IAC_PREVIEW_CHANGED',
        'El plan actual no coincide con la vista previa. Genera otra vista previa antes de confirmar.');
    }
    if (operation.type === 'create') {
      await report('Preparando o reutilizando las referencias de secretos en SSM.', { stage: 'Preparando secretos', progress: 48 });
      await prepareSecrets(tenant, { signal, projectName: base.project_name });
    }
    await report('Aplicando el plan sobre el mismo estado del tenant.', { stage: 'Aplicando infraestructura', progress: 57 });
    if (reviewed.needsApply) await cli(['apply', '-input=false', '-no-color', '-lock-timeout=5m', 'review.tfplan']);
    if (destroying) {
      return { tenantStatus: 'deleted', deployment: { ami: {}, outputs: { mode: 'integration', urls: {}, health: {}, state: binding },
        resources: [], tool_versions: toolVersions(versions, tenant.engine, deployment, image, operation) },
      result: { state_key: binding.key } };
    }
    const output = await cli(['output', '-json'], { captureStdout: true });
    const data = parseJson(output.stdout, 'IAC_OUTPUT_INVALID', 'El motor no devolvió outputs válidos.');
    const outputs = privateOutputs(data, vars);
    const labels = { frontend: 'Frontend', backend: 'Backend', db: 'Base de datos' };
    const resources = roles.map((role) => ({
      role, type: 'ec2', name: labels[role], id: outputs.instance_ids[role], size: vars.sizing[role],
    }));
    resources.push({ role: 'data', type: 'ebs', name: 'Disco de datos', id: outputs.db_volume_id, size: `${vars.sizing.db_disk_gb} GiB` });
    const { health, appVersions, deploymentHealth } = vars.suspended
      ? { health: { frontend: 'paused', backend: 'paused', database: 'paused' }, appVersions: {} }
      : await verifyHealth({ run, config, tenant, base, repoRoot, urls: outputs.urls, instances: outputs.instance_ids, signal, report });
    const nextVersions = toolVersions(versions, tenant.engine, deployment, image, operation);
    if (Object.keys(appVersions).length) nextVersions.app = { ...nextVersions.app, ...appVersions };
    return {
      tenantStatus: vars.suspended ? 'suspended' : 'ready',
      deployment: { ami: image.ami, outputs: { ...outputs, health, mode: 'integration', state: binding }, resources, health: deploymentHealth,
        tool_versions: { ...nextVersions,
          terraform_module: moduleHash.slice(0, 12) } },
      result: { state_key: binding.key },
    };
  } finally {
    // Ni el JSON sin filtrar ni el plan binario se conservan como artefactos.
    requireValue(resolve(cwd).startsWith(join(resolve(directory), 'operation-')), 'IAC_CONFIG',
      'No se pudo verificar el directorio temporal del plan.');
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
  }
}
