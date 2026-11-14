// Ejecutor de CLIs (terraform, tofu, aws, python) para los adaptadores de motor (P2).
// Entrega cada línea en orden, aplica un tiempo máximo y corta el proceso al cancelar.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { OperationError } from '../lib/operation-error.js';

// El proceso hijo no necesita la base ni los secretos de la plataforma.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env))
    if (/^(DATABASE_URL|TEST_DATABASE_URL|DB_|BOOTSTRAP_ADMIN_)/.test(key))
      delete env[key];
  return env;
}

function killTree(child, graceful) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32')
    // En Windows no hay SIGINT para procesos sin consola: se termina el árbol completo.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill());
  // terraform/tofu atienden SIGINT: terminan el paso actual y liberan el bloqueo.
  else child.kill(graceful ? 'SIGINT' : 'SIGTERM');
}

/**
 * Ejecuta un comando y resuelve con { code, stdout, stderrTail } cuando termina.
 *
 * - `onLine(line, stream)` recibe cada línea; si lanza (p. ej. cancelación pedida desde
 *   `report`), el proceso se corta, salvo con `deferStop`, que deja terminar el paso
 *   actual y lanza el error después (útil durante `apply`, para no dejar el estado a medias).
 * - `capture` guarda stdout completo (para `output -json`), sin pasarlo a `onLine`.
 * - `signal` (apagado del worker o pérdida de la operación) siempre corta el proceso.
 */
export function runCli(
  command,
  args,
  {
    cwd,
    env = childEnv(),
    onLine = () => {},
    signal,
    timeoutMs = 600000,
    capture = false,
    deferStop = false,
    label = command,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure = null;
    let deferred = null;
    let chain = Promise.resolve();
    const stdout = [];
    const stderrTail = [];
    let child;
    // Un script .js/.mjs (CLIs simulados de las pruebas) se ejecuta con el mismo Node.
    const script = /\.m?js$/i.test(command);
    try {
      child = spawn(script ? process.execPath : command, script ? [command, ...args] : args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stop = (error, graceful = false) => {
      if (!failure) failure = error;
      killTree(child, graceful);
    };
    const timer = setTimeout(
      () =>
        stop(
          new OperationError(
            `${label} superó el tiempo máximo (${Math.round(timeoutMs / 1000)} s).`,
          ),
          true,
        ),
      timeoutMs,
    );
    const onAbort = () => stop(signal.reason ?? new Error('Aborted'), true);
    if (signal?.aborted) onAbort();
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
        if (name === 'stdout' && capture) {
          stdout.push(raw);
          return;
        }
        if (!line) return;
        if (name === 'stderr') {
          stderrTail.push(line);
          if (stderrTail.length > 60) stderrTail.shift();
        }
        chain = chain
          .then(() => (failure || deferred ? undefined : onLine(line, name)))
          .catch((error) => {
            if (deferStop) deferred ??= error;
            else stop(error);
          });
      });
    read(child.stdout, 'stdout');
    read(child.stderr, 'stderr');
    child.on('error', (error) =>
      stop(
        error.code === 'ENOENT'
          ? new OperationError(
              `No se encontró "${command}". Instálalo o configura su ruta en el .env del worker.`,
            )
          : error,
      ),
    );
    child.on('exit', () => {
      if (!failure) return;
      child.stdout.destroy();
      child.stderr.destroy();
      void chain.then(() => finish(failure));
    });
    child.on('close', (code) => {
      void chain.then(() => {
        if (failure) return finish(failure);
        if (deferred) return finish(deferred);
        finish(null, { code, stdout: stdout.join('\n'), stderrTail });
      });
    });
  });
}
