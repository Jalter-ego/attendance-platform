import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Respaldos (P3): bash que ejecuta infra/backups/tenant-backup.sh. En Windows, Git Bash
// (no el bash de WSL, que no ve las credenciales de AWS de Windows).
const defaultBash =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';
const defaultBackupScript = fileURLToPath(
  new URL('../../../infra/backups/tenant-backup.sh', import.meta.url),
);
// Motores IaC (P2): rutas del monorepo que usa el worker. Todas se pueden sobrescribir.
const repoPath = (relative) =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5001),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  CLIENT_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DB_SSL: boolean.default(false),
  DB_SSL_REJECT_UNAUTHORIZED: boolean.default(true),
  DB_SSL_CA_FILE: z.string().trim().default(''),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  COOKIE_SECURE: boolean.optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(30000).default(1000),
  WORKER_STALE_MS: z.coerce.number().int().min(30000).default(60000),
  BACKUP_BASH: z.string().trim().default(defaultBash),
  BACKUP_SCRIPT: z.string().trim().default(defaultBackupScript),
  BACKUP_TIMEOUT_S: z.coerce.number().int().min(60).max(3600).default(900),
  // Motores IaC (P2). El bucket del estado es el que crea infra/bootstrap; vacío impide
  // ejecutar operaciones de infraestructura (el resto de la plataforma funciona igual).
  IAC_STATE_BUCKET: z.string().trim().default(''),
  IAC_BASE_OUTPUTS: z.string().trim().default(repoPath('.local/base.outputs.json')),
  IAC_AMI_IDS: z.string().trim().default(repoPath('infra/packer/ami-ids.json')),
  IAC_MODULE_DIR: z.string().trim().default(repoPath('infra/terraform/tenant')),
  IAC_CLOUD_INIT_TEMPLATE: z
    .string()
    .trim()
    .default(repoPath('infra/cloud-init/user-data.yaml.tftpl')),
  IAC_PLAN_PREVIEW: z.string().trim().default(repoPath('infra/terraform/plan_preview.py')),
  IAC_RUNS_DIR: z.string().trim().default(repoPath('.local/runs')),
  IAC_CFN_TEMPLATE: z.string().trim().default(repoPath('infra/cloudformation/tenant.yaml')),
  CFN_POLL_MS: z.coerce.number().int().min(10).max(60000).default(10000),
  IAC_TIMEOUT_S: z.coerce.number().int().min(300).max(7200).default(3600),
  HEALTH_TIMEOUT_S: z.coerce.number().int().min(1).max(3600).default(900),
  HEALTH_SCRIPT: z.string().trim().min(1).default(repoPath('infra/health/tenant-health.sh')),
  // Compatibilidad con los nombres de P6 ya usados en .env locales.
  DEPLOYMENT_STATE_BUCKET: z.string().trim().default(''),
  DEPLOYMENT_BASE_OUTPUTS_FILE: z.string().trim().optional(),
  DEPLOYMENT_AMI_FILE: z.string().trim().optional(),
  DEPLOYMENT_WORK_DIR: z.string().trim().optional(),
  TERRAFORM_BIN: z.string().trim().default('terraform'),
  TOFU_BIN: z.string().trim().default('tofu'),
  PYTHON_BIN: z
    .string()
    .trim()
    .default(process.platform === 'win32' ? 'python' : 'python3'),
});

export function readConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Revisa estas variables: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = result.data;
  if (config.IAC_STATE_BUCKET && config.DEPLOYMENT_STATE_BUCKET &&
      config.IAC_STATE_BUCKET !== config.DEPLOYMENT_STATE_BUCKET)
    throw new Error('IAC_STATE_BUCKET y DEPLOYMENT_STATE_BUCKET deben referirse al mismo bucket.');
  const aliases = [
    ['IAC_STATE_BUCKET', 'DEPLOYMENT_STATE_BUCKET'],
    ['IAC_BASE_OUTPUTS', 'DEPLOYMENT_BASE_OUTPUTS_FILE'],
    ['IAC_AMI_IDS', 'DEPLOYMENT_AMI_FILE'],
    ['IAC_RUNS_DIR', 'DEPLOYMENT_WORK_DIR'],
  ];
  for (const [canonical, legacy] of aliases) {
    if (env[canonical] && env[legacy] && env[canonical] !== env[legacy])
      throw new Error(`${canonical} y ${legacy} tienen valores distintos. Conserva una sola configuración.`);
    config[canonical] = env[canonical] || env[legacy] || config[canonical];
    config[legacy] = config[canonical];
  }
  return {
    ...config,
    CLIENT_ORIGIN: new URL(config.CLIENT_ORIGIN).origin,
    COOKIE_SECURE: config.COOKIE_SECURE ?? config.NODE_ENV === 'production',
  };
}
