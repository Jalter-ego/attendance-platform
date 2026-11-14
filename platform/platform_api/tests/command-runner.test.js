import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, CommandError } from '../src/worker/services/command-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/command.mjs', import.meta.url));
const run = (mode, options = {}) => runCommand({
  command: process.execPath, args: [fixture, mode], timeoutMs: 3000, killGraceMs: 60, ...options,
});
const code = (expected) => (error) => error instanceof CommandError && error.code === expected;

test('los argumentos se pasan literalmente, sin interpretación de shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attendance-runner-'));
  const marker = join(directory, 'injected');
  const args = [fixture, 'args', `$(touch ${marker})`, '; echo intruso', 'con espacios'];
  try {
    const result = await run('args', { args, cwd: directory, captureStdout: true });
    assert.deepEqual(JSON.parse(result.stdout), args.slice(2));
    await assert.rejects(access(marker));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('filtra secretos partidos entre chunks y conserva UTF-8 y última línea', async () => {
  const lines = [];
  let active = false;
  await run('chunks', {
    secrets: ['conocido-partido'],
    onLine: async (line, stream) => {
      assert.equal(active, false, 'los callbacks no deben ejecutarse en paralelo');
      active = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      lines.push({ line, stream });
      active = false;
    },
  });
  const stdout = lines.filter((item) => item.stream === 'stdout').map((item) => item.line);
  assert.deepEqual(stdout, ['password=[REDACTED]', '[REDACTED]', 'última sin salto']);
  assert.ok(lines.some((item) => item.stream === 'stderr' && item.line === 'advertencia'));
});

test('JSON privado se captura explícitamente y no se envía a los logs', async () => {
  const lines = [];
  const result = await run('json', { captureStdout: true, logStdout: false, onLine: (line) => lines.push(line) });
  assert.deepEqual(JSON.parse(result.stdout), { value: 'dato-privado', valid: true });
  assert.deepEqual(lines, []);
  assert.equal((await run('json')).stdout, undefined);
  const jsonCommand = await run('json', { args: [fixture, 'json', '0', '-json'], captureStdout: true, onLine: (line) => lines.push(line) });
  assert.equal(JSON.parse(jsonCommand.stdout).valid, true);
  assert.deepEqual(lines, [], 'la salida -json tampoco debe registrarse por defecto');
});

test('admite el exit code 2 de plan detallado solo cuando el adaptador lo indica', async () => {
  await assert.rejects(run('json', { args: [fixture, 'json', '2'] }), code('COMMAND_FAILED'));
  assert.equal((await run('json', { args: [fixture, 'json', '2'], acceptedExitCodes: [0, 2] })).exitCode, 2);
});

test('envía configuración privada por stdin y excluye credenciales de la plataforma', async () => {
  const input = '{"password":"dato-privado"}';
  const result = await run('stdin', { input, captureStdout: true, logStdout: false });
  assert.equal(result.stdout, input);
  const environment = await run('environment', { captureStdout: true, env: {
    DATABASE_URL: 'postgresql://user:oculto@host/db', DB_READ_PASSWORD: 'oculto',
    BOOTSTRAP_ADMIN_PASSWORD: 'oculto', JWT_SECRET: 'oculto', NODE_OPTIONS: '--invalid',
    TF_LOG: 'TRACE', TF_LOG_PATH: '/ruta/que/no/debe/crearse', AWS_PROFILE: 'perfil-prueba',
  } });
  assert.deepEqual(JSON.parse(environment.stdout), { leaked: [], profile: 'perfil-prueba' });
});

test('oculta mensajes nativos que podrían contener argumentos privados', async () => {
  await assert.rejects(runCommand({ command: 'attendance-herramienta-inexistente', args: ['dato-privado'] }), (error) => {
    assert.ok(code('COMMAND_NOT_FOUND')(error));
    assert.ok(!error.message.includes('dato-privado'));
    return true;
  });
});

test('rechaza una señal ya cancelada antes de lanzar el proceso', async () => {
  await assert.rejects(run('silent', { signal: AbortSignal.abort() }), code('COMMAND_CANCELLED'));
});

test('agota el tiempo máximo aunque el proceso no escriba nada', async () => {
  const start = Date.now();
  await assert.rejects(run('silent', { timeoutMs: 100 }), code('COMMAND_TIMEOUT'));
  assert.ok(Date.now() - start < 2000);
});

test('un callback de logs bloqueado tampoco impide agotar el tiempo máximo', async () => {
  await assert.rejects(run('progress', {
    timeoutMs: 150, onLine: () => new Promise(() => {}),
  }), code('COMMAND_TIMEOUT'));
});

test('si falla la persistencia del log detiene el proceso y propaga la causa', async () => {
  const failure = new Error('base no disponible');
  await assert.rejects(run('progress', { onLine: () => { throw failure; } }), (error) => error === failure);
});

test('limita la memoria de líneas incompletas y la captura de JSON privado', async () => {
  const lines = [];
  await assert.rejects(run('flood', { maxLineBytes: 128, onLine: (line) => lines.push(line) }), code('COMMAND_OUTPUT_LIMIT'));
  assert.deepEqual(lines, []);
  await assert.rejects(run('flood', { maxOutputBytes: 128, logStdout: false, captureStdout: true }), code('COMMAND_OUTPUT_LIMIT'));
});

async function stopped(pid) {
  try {
    // Un hijo terminado puede quedar zombie hasta que lo recoja PID 1.
    if (process.platform === 'linux') return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
}

test('cancelar termina padre e hijo, incluso si ignoran SIGTERM', { skip: process.platform === 'win32' }, async (t) => {
  const controller = new AbortController();
  let ids;
  t.after(() => {
    if (ids) for (const pid of Object.values(ids)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  await assert.rejects(run('tree', { signal: controller.signal, onLine: (line) => {
    ids = JSON.parse(line);
    controller.abort();
  } }), code('COMMAND_CANCELLED'));
  assert.ok(ids);
  assert.equal(await stopped(ids.parent), true);
  assert.equal(await stopped(ids.child), true);
});

test('el timeout termina un hijo aun cuando su padre ya salió', { skip: process.platform === 'win32' }, async (t) => {
  let ids;
  t.after(() => {
    if (ids) for (const pid of Object.values(ids)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  await assert.rejects(run('orphan', { timeoutMs: 500, onLine: (line) => { ids = JSON.parse(line); } }), code('COMMAND_TIMEOUT'));
  assert.ok(ids);
  assert.equal(await stopped(ids.child), true);
});
