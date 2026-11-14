import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogRedactor } from '../../lib/redact.js';
import { OperationError } from '../errors.js';

export class CommandError extends OperationError {
  constructor(code, message, exitCode = null) {
    super(code, message);
    this.name = 'CommandError';
    this.exitCode = exitCode;
  }
}

const sensitiveName = /password|passwd|secret|token|access[_-]?key|private[_-]?key|database_url/i;

// Mantener las credenciales AWS del operador; quitar las de la aplicación.
function commandEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(DATABASE_URL|DB_|PGPASSWORD|BOOTSTRAP_ADMIN_|JWT_|SESSION_|NODE_OPTIONS|TF_LOG)/i.test(key))
      delete env[key];
  }
  return { ...env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', NO_COLOR: '1' };
}

async function terminateTree(child, graceMs) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Git Bash puede dejar vivos aws.exe/sleep.exe si solo se termina bash.exe.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, graceMs + 1000);
      killer.once('error', () => { child.kill(); clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
    return;
  }
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  };
  if (!kill('SIGTERM')) return;
  // Incluso si el padre termina, hay que terminar los hijos que ignoren SIGTERM.
  await sleep(graceMs);
  kill('SIGKILL');
}

/**
 * Solo lo llaman servicios/adaptadores internos: jamás aceptar un comando HTTP.
 * onLine recibe texto filtrado; stdout solo se captura por petición explícita y
 * es privado (puede contener secretos). El llamador debe validar su JSON.
 */
export async function runCommand({
  command, args = [], cwd, env = {}, signal, input,
  timeoutMs = 15 * 60 * 1000, killGraceMs = 5000,
  maxOutputBytes = 8 * 1024 * 1024, maxLineBytes = 64 * 1024,
  acceptedExitCodes = [0], captureStdout = false, logStdout = true,
  onLine = () => {}, secrets = [],
}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      args.some((arg) => typeof arg !== 'string') ||
      typeof onLine !== 'function' || !Array.isArray(secrets) ||
      (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) ||
      ![timeoutMs, killGraceMs, maxOutputBytes, maxLineBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      timeoutMs > 2147483647 || killGraceMs > 2147482647 ||
      !Array.isArray(acceptedExitCodes) || !acceptedExitCodes.length ||
      acceptedExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255))
    throw new CommandError('COMMAND_CONFIG', 'La configuración de la herramienta no es válida.');
  const cancelled = () => new CommandError('COMMAND_CANCELLED', 'Operación cancelada.');
  if (signal?.aborted) throw cancelled();

  const childEnv = commandEnv(env);
  const knownSecrets = [...secrets, ...Object.entries({ ...process.env, ...env })
    .filter(([name]) => sensitiveName.test(name)).map(([, value]) => value)];
  const sanitize = createLogRedactor(knownSecrets);
  // show -json puede incluir valores sensibles bajo nombres genéricos como value.
  const emitStdout = logStdout && !args.includes('-json');
  let child;
  try {
    child = spawn(command, args, {
      cwd, env: childEnv, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new CommandError('COMMAND_START_FAILED', 'No se pudo iniciar la herramienta configurada.');
  }

  let failure;
  let termination;
  let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  // También se usa dentro de las lecturas y callbacks: siempre tiene consumidor.
  stopped.catch(() => {});
  const stop = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new CommandError('COMMAND_LOG_FAILED', 'No se pudo registrar el progreso de la operación.');
    termination = terminateTree(child, killGraceMs);
    termination.catch(() => {});
    rejectStop(failure);
  };
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  child.once('error', (error) => stop(new CommandError(
    error.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'COMMAND_START_FAILED',
    error.code === 'ENOENT' ? 'No se encontró la herramienta configurada. Revisa su instalación y ruta.'
      : 'No se pudo iniciar la herramienta configurada.',
  )));
  const onAbort = () => stop(cancelled());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => stop(new CommandError(
    'COMMAND_TIMEOUT', 'La herramienta superó el tiempo máximo. Revisa el estado antes de reintentar.',
  )), timeoutMs);

  let outputBytes = 0;
  const stdout = [];
  let callbacks = Promise.resolve();
  const emit = async (line, stream) => {
    if (failure || !line.trim()) return;
    const safe = sanitize(line.trimEnd(), stream);
    callbacks = callbacks.then(() => failure ? undefined : onLine(safe, stream));
    // Una escritura de logs bloqueada no debe impedir cancelar ni agotar el timeout.
    await Promise.race([callbacks, stopped]);
  };
  const read = async (stream, name) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const lines = async (text, final = false) => {
      pending += text;
      const parts = pending.split(/\r\n|\r|\n/);
      pending = final ? '' : parts.pop();
      for (const line of parts) {
        if (Buffer.byteLength(line) > maxLineBytes) throw new CommandError(
          'COMMAND_OUTPUT_LIMIT', 'La salida de la herramienta superó el límite permitido.',
        );
        await emit(line, name);
      }
      if (Buffer.byteLength(pending) > maxLineBytes) throw new CommandError(
        'COMMAND_OUTPUT_LIMIT', 'La salida de la herramienta superó el límite permitido.',
      );
    };
    try {
      for await (const chunk of stream) {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) throw new CommandError(
          'COMMAND_OUTPUT_LIMIT', 'La salida de la herramienta superó el límite permitido.',
        );
        if (captureStdout && name === 'stdout') stdout.push(chunk);
        if (name !== 'stdout' || emitStdout) await lines(decoder.write(chunk));
      }
      if (name !== 'stdout' || emitStdout) await lines(decoder.end(), true);
    } catch (error) { stop(error); }
  };
  const readers = [read(child.stdout, 'stdout'), read(child.stderr, 'stderr')];
  if (input !== undefined) {
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop(new CommandError('COMMAND_INPUT_FAILED', 'No se pudo enviar la configuración a la herramienta.'));
    });
    child.stdin.end(input);
  }
  try {
    const [{ code, signal: exitSignal }] = await Promise.race([Promise.all([closed, ...readers]), stopped]);
    if (failure) throw failure;
    if (exitSignal || !acceptedExitCodes.includes(code)) {
      stop(new CommandError(
        'COMMAND_FAILED', code === null ? 'La herramienta terminó de forma inesperada.'
          : `La herramienta terminó con código ${code}. Revisa los eventos de la operación.`, code,
      ));
      throw failure;
    }
    return { exitCode: code, stdout: captureStdout ? Buffer.concat(stdout).toString('utf8') : undefined };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (failure) {
      try { await termination; } catch { /* El error público nunca contiene rutas ni argumentos. */ }
      // Esperar también el cierre de las tuberías del árbol, no solo enviar señales.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        closed.then(() => { clearTimeout(timer); resolve(); });
      });
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
