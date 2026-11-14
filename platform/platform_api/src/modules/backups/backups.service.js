// Respaldos de tenants (P3). Ejecuta infra/backups/tenant-backup.sh, que usa AWS CLI con las
// credenciales del proceso (perfil/variables de AWS del worker): dump en la VM db por SSM Run
// Command + snapshot EBS, restauración y listado. La última línea de su salida es JSON.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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

// El script no necesita la base ni los secretos de la plataforma.
function childEnv() {
  // AWS CLI en Windows escribe con la página de códigos del sistema; se pide UTF-8.
  const env = {
    ...process.env,
    MSYS_NO_PATHCONV: '1',
    AWS_CLI_OUTPUT_ENCODING: 'UTF-8',
  };
  for (const key of Object.keys(env))
    if (/^(DATABASE_URL|DB_|BOOTSTRAP_ADMIN_)/.test(key)) delete env[key];
  return env;
}

export function runBackupScript(
  config,
  command,
  tenant,
  { backupId, onLine = () => {}, signal, timeoutMs } = {},
) {
  const args = [
    config.BACKUP_SCRIPT.replaceAll('\\', '/'),
    command,
    '--tenant',
    tenant.tenant_id,
    '--env',
    tenant.env,
    '--region',
    tenant.region,
    '--timeout',
    String(config.BACKUP_TIMEOUT_S),
  ];
  if (backupId) args.push('--id', backupId);
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastJson = null;
    let lastError = '';
    let chain = Promise.resolve();
    let failure = null;
    const child = spawn(config.BACKUP_BASH, args, {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stop = (error) => {
      if (!failure) failure = error;
      if (child.exitCode !== null || child.pid === undefined) return;
      // En Windows, matar bash.exe deja vivos a sus hijos (aws, sleep) y la operación
      // seguiría esperando: se termina el árbol completo.
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => child.kill());
      else child.kill();
    };
    const timer = setTimeout(
      () =>
        stop(
          new ScriptError(
            `tenant-backup.sh superó el tiempo máximo (${Math.round((timeoutMs ?? config.BACKUP_TIMEOUT_S * 1000 + 60000) / 1000)} s).`,
          ),
        ),
      timeoutMs ?? config.BACKUP_TIMEOUT_S * 1000 + 60000,
    );
    const onAbort = () => stop(signal.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const read = (stream, name) =>
      createInterface({ input: stream }).on('line', (raw) => {
        const line = raw.trimEnd();
        if (!line) return;
        if (name === 'stdout' && line.startsWith('{')) {
          try {
            lastJson = JSON.parse(line);
          } catch {
            /* línea de progreso que empieza con "{" */
          }
        }
        if (name === 'stderr' && line.startsWith('ERROR:'))
          lastError = line.slice(6).trim();
        // Los callbacks se encadenan para conservar el orden de los eventos.
        chain = chain
          .then(() => (failure ? undefined : onLine(line, name)))
          .catch(stop);
      });
    read(child.stdout, 'stdout');
    read(child.stderr, 'stderr');
    child.on('error', (error) =>
      stop(
        error.code === 'ENOENT'
          ? new ScriptError(
              `No se encontró bash en "${config.BACKUP_BASH}". Configura BACKUP_BASH.`,
            )
          : error,
      ),
    );
    // Si se cortó a propósito no se espera a que se cierren las tuberías: con Git Bash el
    // comando hijo en curso (aws, sleep) no cuelga del árbol de Windows y las mantiene
    // abiertas unos segundos. Muerto bash, no se ejecuta ningún paso más del script.
    child.on('exit', () => {
      if (!failure) return;
      child.stdout.destroy();
      child.stderr.destroy();
      void chain.then(() => finish(failure));
    });
    child.on('close', (code) => {
      void chain.then(() => {
        if (failure) return finish(failure);
        if (code !== 0)
          return finish(
            new ScriptError(
              lastError || `tenant-backup.sh terminó con código ${code}.`,
            ),
          );
        if (!lastJson)
          return finish(
            new ScriptError('tenant-backup.sh no devolvió un resultado.'),
          );
        finish(null, lastJson);
      });
    });
  });
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
