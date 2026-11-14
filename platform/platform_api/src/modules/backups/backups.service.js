// Respaldos de tenants (P3). Ejecuta infra/backups/tenant-backup.sh, que usa AWS CLI con las
// credenciales del proceso (perfil/variables de AWS del worker): dump en la VM db por SSM Run
// Command + snapshot EBS, restauración y listado. La última línea de su salida es JSON.
import { runCommand, CommandError } from '../../worker/services/command-runner.js';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { getTenant } from '../tenants/tenants.service.js';

export const BACKUP_ID = /^\d{8}T\d{6}Z-(manual|scheduled|pre-restore)$/;
export const backupIdInput = z.union([
  z.literal('latest'),
  z.string().regex(BACKUP_ID, 'Identificador de respaldo inválido.'),
]);

// Error con un mensaje apto para mostrar en la operación.
export class ScriptError extends Error {}

// Reutiliza el ejecutor del worker; conserva el contrato de P3 y su JSON final.
export async function runBackupScript(
  config,
  command,
  tenant,
  { backupId, onLine = () => {}, signal, timeoutMs } = {},
) {
  const args = [
    config.BACKUP_SCRIPT.replaceAll('\\', '/'), command,
    '--tenant', tenant.tenant_id, '--env', tenant.env, '--region', tenant.region,
    '--timeout', String(config.BACKUP_TIMEOUT_S),
  ];
  if (backupId) args.push('--id', backupId);
  let lastError = '';
  let stdout;
  try {
    ({ stdout } = await runCommand({
      command: config.BACKUP_BASH,
      args,
      env: { MSYS_NO_PATHCONV: '1', AWS_CLI_OUTPUT_ENCODING: 'UTF-8' },
      signal,
      timeoutMs: timeoutMs ?? config.BACKUP_TIMEOUT_S * 1000 + 60000,
      killGraceMs: 1000,
      captureStdout: true,
      onLine: (line, stream) => {
        if (stream === 'stderr' && line.startsWith('ERROR:'))
          lastError = line.slice(6).trim();
        return onLine(line, stream);
      },
    }));
  } catch (error) {
    if (!(error instanceof CommandError) || error.code === 'COMMAND_CANCELLED') throw error;
    throw new ScriptError(error.code === 'COMMAND_NOT_FOUND'
      ? 'No se encontró bash. Configura BACKUP_BASH y revisa su instalación.'
      : error.code === 'COMMAND_FAILED' && lastError ? lastError : error.message);
  }
  let result;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { result = JSON.parse(line); }
    catch { /* Las líneas de progreso pueden empezar con una llave. */ }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new ScriptError('tenant-backup.sh no devolvió un resultado válido.');
  return result;
}

// Une dumps (S3) y snapshots (EBS) por backup_id. Los snapshots programados de DLM no
// tienen BackupId: se listan aparte y no se pueden restaurar desde la plataforma.
export function mergeBackups(list) {
  const items = new Map();
  const entry = (id) => {
    if (!items.has(id)) {
      const match = BACKUP_ID.exec(id);
      items.set(id, {
        backup_id: id,
        type: match?.[1] ?? 'snapshot',
        created_at: match
          ? id.replace(
              /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z.*/,
              '$1-$2-$3T$4:$5:$6Z',
            )
          : null,
        dump: null,
        snapshot: null,
        restorable: false,
      });
    }
    return items.get(id);
  };
  for (const dump of list.dumps ?? []) {
    const id = dump.key.split('/').pop().replace(/\.dump$/, '');
    if (!BACKUP_ID.test(id)) continue;
    const item = entry(id);
    item.dump = {
      key: dump.key,
      bytes: dump.bytes,
      last_modified: dump.last_modified,
    };
    item.restorable = true;
  }
  for (const snapshot of list.snapshots ?? []) {
    const item = entry(snapshot.backup_id || snapshot.snapshot_id);
    item.snapshot = {
      snapshot_id: snapshot.snapshot_id,
      state: snapshot.state,
      gib: snapshot.gib,
      started: snapshot.started,
    };
    if (!snapshot.backup_id) item.type = snapshot.type || 'scheduled';
    item.created_at ??= snapshot.started;
  }
  return [...items.values()].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

export async function listBackups(pool, config, user, id) {
  const tenant = await getTenant(pool, user, id);
  let list;
  try {
    list = await runBackupScript(config, 'list', tenant, { timeoutMs: 90000 });
  } catch (error) {
    throw new HttpError(
      502,
      'BACKUP_LIST_FAILED',
      error instanceof ScriptError
        ? `No se pudieron consultar los respaldos: ${error.message}`
        : 'No se pudieron consultar los respaldos en AWS.',
    );
  }
  return {
    tenant_id: tenant.tenant_id,
    env: tenant.env,
    bucket: list.bucket,
    items: mergeBackups(list),
  };
}

// Etapas visibles según las marcas "== ..." que imprime tenant-backup.sh.
const stages = {
  backup: [
    [/^== SSM /, 30, 'Volcando la base en la VM db'],
    [/^== subiendo /, 55, 'Subiendo el volcado a S3'],
    [/^== snapshot /, 75, 'Creando snapshot EBS'],
    [/^== respaldo /, 95, 'Registrando el respaldo'],
  ],
  restore: [
    [/^== SSM /, 30, 'Restaurando en la VM db'],
    [/pre-restore/, 50, 'Copia previa a la restauración'],
  ],
};

// Handler del worker para las operaciones backup y restore.
export async function runBackupOperation({
  pool,
  config,
  operation,
  report,
  signal,
}) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE id = $1', [
    operation.tenant_id,
  ]);
  if (!rows.length) throw new ScriptError('La institución ya no existe.');
  const tenant = rows[0];
  const restore = operation.type === 'restore';
  const backupId = restore ? operation.params?.backup_id : undefined;
  if (restore && !backupIdInput.safeParse(backupId).success)
    throw new ScriptError('Falta un identificador de respaldo válido.');
  await report(
    restore
      ? `Restaurar ${tenant.tenant_id}/${tenant.env} desde ${backupId}.`
      : `Respaldar ${tenant.tenant_id}/${tenant.env}: volcado lógico a S3 y snapshot EBS.`,
    { stage: 'Buscando la VM db', progress: 10 },
  );
  const result = await runBackupScript(config, operation.type, tenant, {
    backupId,
    signal,
    onLine: (line, stream) => {
      const stage = stages[operation.type].find(([pattern]) =>
        pattern.test(line),
      );
      return report(line, {
        stage: stage?.[2],
        progress: stage?.[1],
        level: stream === 'stderr' ? 'warning' : 'info',
      });
    },
  });
  await report(
    restore
      ? 'Restauración terminada. La base del tenant quedó como en el respaldo.'
      : `Respaldo ${result.backup_id} listo${result.snapshot_id ? ` (snapshot ${result.snapshot_id})` : ''}.`,
    { stage: restore ? 'Restauración terminada' : 'Respaldo listo', progress: 100 },
  );
  return result;
}
