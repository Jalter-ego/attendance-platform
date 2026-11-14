import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { tenantInput } from '../tenants/tenants.service.js';
import { OperationError } from '../../worker/errors.js';
import { BACKUP_BY_PLAN } from '../../engines/tenant-input.js';

const awsId = (prefix) => z.string().regex(new RegExp(`^${prefix}-[a-f0-9]{8}([a-f0-9]{9})?$`));
const amiId = z.string().regex(/^ami-[a-f0-9]{17}$/).refine((id) => id !== 'ami-00000000000000000');
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const baseSchema = z.object({
  project_name: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  availability_zone: z.string().regex(/^[a-z]{2}-[a-z]+-\d[a-z]$/),
  vpc_id: awsId('vpc'), public_subnet_id: awsId('subnet'), private_subnet_id: awsId('subnet'),
  monitoring_security_group_id: awsId('sg'), ssm_endpoint_id: awsId('vpce'),
  backups_bucket: z.union([bucket, z.literal('')]).default(''),
});
const amiSchema = z.object({ frontend: amiId, backend: amiId, db: amiId });
const size = z.enum(['t3.micro', 't3.small', 't3.medium', 't3.large']);
const sizing = z.object({ frontend: size, backend: size, db: size, db_disk_gb: z.number().int().min(10) });
const limits = z.object({
  max_students: z.number().int().positive().optional(),
  max_teachers: z.number().int().positive().optional(),
  max_courses: z.number().int().positive().optional(),
});
export const deploymentSnapshot = z.object({
  version: z.literal(1),
  input: tenantInput.extend({ base: baseSchema, sizing, limits, ami: amiSchema, suspended: z.literal(false),
    backup: z.object({ schedule: z.enum(['daily', 'weekly']), retention_days: z.number().int().positive() }).nullable().optional(),
  }),
  backend: z.union([
    z.object({ bucket, region: z.string(), key: z.string(), encrypt: z.literal(true), use_lockfile: z.literal(true) }),
    z.object({ type: z.literal('cloudformation'), region: z.string(), stack_name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/) }),
  ]),
  image_version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  image_git_commit: z.string().regex(/^[a-f0-9]{7,40}$/).nullable().optional(),
});

async function readJson(path) {
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Configuration too large');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

export function validateSnapshot(snapshot, tenant) {
  const result = deploymentSnapshot.safeParse(snapshot);
  if (!result.success) throw new OperationError('DEPLOYMENT_CONFIG', 'La configuración del despliegue no está completa o no es válida.');
  const value = result.data;
  if (value.input.tenant_id !== tenant.tenant_id || value.input.env !== tenant.env ||
      value.input.engine !== tenant.engine || value.input.region !== tenant.region ||
      value.input.base.region !== tenant.region || value.backend.region !== tenant.region)
    throw new OperationError('DEPLOYMENT_IDENTITY', 'La configuración guardada no corresponde a esta institución, entorno o motor.');
  if (tenant.engine === 'cloudformation') {
    if (value.backend.type !== 'cloudformation' ||
        value.backend.stack_name !== `${value.input.base.project_name}-${tenant.tenant_id}-${tenant.env}`)
      throw new OperationError('DEPLOYMENT_IDENTITY', 'El stack guardado no corresponde a esta institución y entorno.');
  } else if (value.backend.type || value.backend.key !== `tenants/${tenant.tenant_id}/${tenant.env}/terraform.tfstate`)
    throw new OperationError('DEPLOYMENT_IDENTITY', 'La clave de estado guardada no corresponde a esta institución y entorno.');
  return value;
}

export async function buildSnapshot(tenant, plan, config) {
  try {
    const [rawBase, catalog] = await Promise.all([
      readJson(config.DEPLOYMENT_BASE_OUTPUTS_FILE), readJson(config.DEPLOYMENT_AMI_FILE),
    ]);
    const base = rawBase?.integration?.value ?? rawBase;
    if (catalog.region !== tenant.region) throw new Error('AMI region mismatch');
    return validateSnapshot({
      version: 1,
      input: { ...tenantInput.parse({
        tenant_id: tenant.tenant_id, name: tenant.name, env: tenant.env, region: tenant.region,
        plan: tenant.plan, engine: tenant.engine, contact_email: tenant.contact_email, timezone: tenant.timezone,
      }), base, sizing: plan.sizing, limits: plan.limits, ami: catalog.ami, suspended: false,
        backup: BACKUP_BY_PLAN[tenant.plan] ?? null },
      backend: tenant.engine === 'cloudformation'
        ? { type: 'cloudformation', region: tenant.region, stack_name: `${base.project_name}-${tenant.tenant_id}-${tenant.env}` }
        : { bucket: config.DEPLOYMENT_STATE_BUCKET, region: tenant.region,
          key: `tenants/${tenant.tenant_id}/${tenant.env}/terraform.tfstate`, encrypt: true, use_lockfile: true },
      image_version: catalog.image_version,
      image_git_commit: catalog.git_commit ?? null,
    }, tenant);
  } catch {
    throw new OperationError('DEPLOYMENT_CONFIG', 'La configuración del despliegue no está completa. Revisa la base compartida, las AMIs, el bucket de estado y el plan.');
  }
}

const instanceIds = z.object({ frontend: awsId('i'), backend: awsId('i'), db: awsId('i') });
const privateIps = z.object({ frontend: z.ipv4(), backend: z.ipv4(), db: z.ipv4() });

// Construir el resultado público: no copiar JSON arbitrario de show/outputs.
export function publicDeployment(raw, versions, snapshot, { suspended = false } = {}) {
  try {
    const ids = instanceIds.parse(raw.instance_ids);
    if (new Set(Object.values(ids)).size !== 3) throw new Error('Repeated instances');
    const ips = privateIps.parse(raw.private_ips);
    const frontend = suspended ? null : new URL(raw.urls.frontend);
    if (!suspended) {
      if (!['http:', 'https:'].includes(frontend.protocol) || frontend.username || frontend.password ||
        frontend.pathname !== '/' || frontend.search || frontend.hash)
        throw new Error('Invalid frontend URL');
    }
    const root = frontend?.href;
    const outputs = {
      urls: suspended ? { frontend: null, api: null, frontend_health: null, backend_health: null }
        : { frontend: root, api: `${root}core/api/v1`, frontend_health: `${root}healthz`, backend_health: `${root}core/api/v1/health` },
      instance_ids: ids, private_ips: ips, ami_ids: snapshot.input.ami,
      ssm_prefix: `/tenants/${snapshot.input.tenant_id}/${snapshot.input.env}`,
      suspended,
    };
    if (snapshot.input.engine === 'cloudformation') {
      const name = snapshot.backend.stack_name;
      const arn = z.string().regex(new RegExp(`^arn:(aws|aws-us-gov|aws-cn):cloudformation:${snapshot.backend.region}:\\d{12}:stack/${name}/[a-zA-Z0-9-]+$`));
      if (raw.stack_name !== name) throw new Error('Stack identity mismatch');
      outputs.stack_name = name;
      outputs.stack_id = arn.parse(raw.stack_id);
    }
    const resources = Object.entries(ids).map(([role, id]) => ({ type: 'aws_instance', role, id }));
    if (raw.db_volume_id) {
      outputs.db_volume_id = awsId('vol').parse(raw.db_volume_id);
      resources.push({ type: 'aws_ebs_volume', role: 'db', id: outputs.db_volume_id });
    }
    const tool_versions = { ami: snapshot.image_version };
    for (const key of ['terraform', 'tofu', 'pulumi', 'cloudformation', 'aws', 'node', 'packer', 'ansible', 'app', 'templates',
      'provider_aws', 'image_version', 'image_git_commit', 'templates_commit', 'aws_sdk', 'template_sha256']) {
      const value = versions?.[key];
      if (typeof value === 'string' && (/^[v\d][\da-zA-Z.+_/-]{0,119}$/.test(value) || /^[a-f0-9]{7,40}$/.test(value)))
        tool_versions[key] = value;
    }
    if (snapshot.input.engine === 'cloudformation') tool_versions.cloudformation = 'AWS (administrado)';
    return { engine: snapshot.input.engine, ami: snapshot.input.ami, outputs, resources, tool_versions };
  } catch {
    throw new OperationError('DEPLOYMENT_OUTPUTS', 'El motor no devolvió los recursos y accesos esperados de la instalación.');
  }
}
