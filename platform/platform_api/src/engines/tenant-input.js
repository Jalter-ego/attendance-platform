// Entrada común a todos los motores (contrato §7 del plan y docs/contratos-integracion.md).
// Se arma con el tenant, su plan, los outputs de la base (P1) y las AMIs de Packer (P3).
// No contiene secretos: las contraseñas viven en SSM y el IaC solo recibe el prefijo.
import { readFile } from 'node:fs/promises';
import { OperationError } from '../lib/operation-error.js';

// Respaldo por plan, admitido por infra/terraform/tenant (variable "backup").
export const BACKUP_BY_PLAN = {
  basic: { schedule: 'weekly', retention_days: 28 },
  standard: { schedule: 'daily', retention_days: 14 },
  advanced: { schedule: 'daily', retention_days: 30 },
};

const BASE_FIELDS = [
  'project_name',
  'region',
  'availability_zone',
  'vpc_id',
  'public_subnet_id',
  'private_subnet_id',
  'monitoring_security_group_id',
  'ssm_endpoint_id',
];

async function readJson(path, what) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new OperationError(`No se encontró ${what} en ${path}.`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new OperationError(`${what} (${path}) no es JSON válido.`);
  }
}

/** Outputs de infra/terraform/base (`terraform output -json integration`). */
export async function readBaseOutputs(config) {
  const raw = await readJson(
    config.IAC_BASE_OUTPUTS,
    'los outputs de la base (terraform output -json integration)',
  );
  // Acepta también el formato de `terraform output -json` completo.
  const base = raw?.integration?.value ?? raw;
  const missing = BASE_FIELDS.filter((field) => !base?.[field]);
  if (missing.length)
    throw new OperationError(
      `Faltan campos en los outputs de la base: ${missing.join(', ')}. Vuelve a exportarlos.`,
    );
  return base;
}

/** AMIs de Packer (infra/packer/ami-ids.json). */
export async function readAmiIds(config) {
  const data = await readJson(config.IAC_AMI_IDS, 'el archivo de AMIs');
  const ami = {
    frontend: data?.ami?.frontend,
    backend: data?.ami?.backend,
    db: data?.ami?.db,
  };
  if (!Object.values(ami).every((id) => /^ami-[a-f0-9]{8,17}$/.test(id ?? '')))
    throw new OperationError(
      'El archivo de AMIs no tiene IDs válidos para frontend, backend y db.',
    );
  return {
    ami,
    region: data.region,
    image_version: data.image_version ?? null,
    git_commit: data.git_commit ?? null,
  };
}

/**
 * Construye la entrada del despliegue. `suspended` es el estado deseado de las EC2
 * (crear y reanudar: false; suspender: true).
 */
export async function buildTenantInput(config, tenant, plan, { suspended }) {
  const [base, images] = await Promise.all([
    readBaseOutputs(config),
    readAmiIds(config),
  ]);
  if (base.region !== tenant.region)
    throw new OperationError(
      `El tenant usa la región ${tenant.region}, pero la base está en ${base.region}.`,
    );
  if (images.region && images.region !== tenant.region)
    throw new OperationError(
      `Las AMIs son de ${images.region}; el tenant usa ${tenant.region}.`,
    );
  if (!plan)
    throw new OperationError(`El plan ${tenant.plan} no existe en el catálogo.`);
  return {
    tenant_id: tenant.tenant_id,
    name: tenant.name,
    env: tenant.env,
    region: tenant.region,
    plan: tenant.plan,
    engine: tenant.engine,
    contact_email: tenant.contact_email,
    timezone: tenant.timezone,
    sizing: plan.sizing,
    limits: plan.limits ?? {},
    backup: BACKUP_BY_PLAN[tenant.plan] ?? BACKUP_BY_PLAN.basic,
    ami: images.ami,
    suspended,
    base,
    image: {
      version: images.image_version,
      git_commit: images.git_commit,
    },
  };
}
