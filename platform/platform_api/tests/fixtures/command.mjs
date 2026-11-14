import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === 'args') {
  console.log(JSON.stringify(process.argv.slice(3)));
} else if (mode === 'chunks') {
  process.stdout.write('password="una ');
  await sleep(20);
  process.stdout.write('clave con espacios"\nconocido-');
  await sleep(20);
  process.stdout.write('partido\n');
  const accent = Buffer.from('última sin salto');
  process.stdout.write(accent.subarray(0, 1));
  await sleep(20);
  process.stdout.write(accent.subarray(1));
  process.stderr.write('advertencia\n');
} else if (mode === 'json') {
  console.log(JSON.stringify({ value: 'dato-privado', valid: true }));
  process.exitCode = Number(process.argv[3] ?? 0);
} else if (mode === 'stdin') {
  for await (const chunk of process.stdin) process.stdout.write(chunk);
} else if (mode === 'environment') {
  console.log(JSON.stringify({
    leaked: Object.keys(process.env).filter((key) => /^(DATABASE_URL|DB_|BOOTSTRAP_ADMIN_|JWT_|SESSION_|NODE_OPTIONS|TF_LOG)/.test(key)),
    profile: process.env.AWS_PROFILE,
  }));
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(8192));
  setInterval(() => {}, 1000);
} else if (mode === 'tree' || mode === 'orphan') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'stubborn'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.once('message', () => {
    console.log(JSON.stringify({ parent: process.pid, child: child.pid }));
    child.disconnect();
    if (mode === 'orphan') child.unref();
  });
  if (mode === 'tree') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  process.send?.('ready');
  setInterval(() => {}, 1000);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  console.log('progreso');
}
