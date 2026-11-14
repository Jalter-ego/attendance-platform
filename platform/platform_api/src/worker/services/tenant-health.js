import { z } from 'zod';
import { runCommand, CommandError } from './command-runner.js';
import { OperationError } from '../errors.js';

const check = z.object({ status: z.number().int().min(0).max(599), ms: z.number().int().min(0) });
const responseSchema = z.object({
  tenant: z.string(), env: z.enum(['test', 'prod']), status: z.enum(['healthy', 'unhealthy']),
  checks: z.object({ frontend: check, backend: check }),
  attempts: z.number().int().positive(), elapsed_s: z.number().int().min(0),
});

export async function checkTenantHealth({ tenant, url, projectName, config, signal, report }) {
  let result;
  try {
    result = await runCommand({
      command: config.BACKUP_BASH,
      args: [config.HEALTH_SCRIPT.replaceAll('\\', '/'), '--tenant', tenant.tenant_id,
        '--env', tenant.env, '--url', url, '--region', tenant.region,
        '--project', projectName, '--timeout', String(config.HEALTH_TIMEOUT_S)],
      env: { MSYS_NO_PATHCONV: '1', AWS_CLI_OUTPUT_ENCODING: 'UTF-8' },
      signal, timeoutMs: (config.HEALTH_TIMEOUT_S + 30) * 1000,
      captureStdout: true, acceptedExitCodes: [0, 1],
      onLine: (line, stream) => {
        // El JSON puede incluir body/boot privados. Solo registrar progreso.
        if (!line.trimStart().startsWith('{')) return report(line, { level: stream === 'stderr' ? 'warning' : 'info' });
      },
    });
  } catch (error) {
    if (!(error instanceof CommandError) || error.code === 'COMMAND_CANCELLED') throw error;
    throw new OperationError('HEALTH_COMMAND_FAILED', 'No se pudo ejecutar la comprobación de salud de la instalación. Revisa sus eventos.');
  }
  try {
    const last = result.stdout.trim().split(/\r?\n/).at(-1);
    const health = responseSchema.parse(JSON.parse(last));
    if (health.tenant !== tenant.tenant_id || health.env !== tenant.env ||
        (health.status === 'healthy') !== (result.exitCode === 0) ||
        (health.status === 'healthy' && (health.checks.frontend.status !== 200 || health.checks.backend.status !== 200)))
      throw new Error('Health mismatch');
    return health;
  } catch {
    throw new OperationError('HEALTH_RESULT', 'La comprobación de salud no devolvió un resultado válido para esta institución.');
  }
}
