// Pulumi CLI driver: isolated workspace, DIY S3 backend, saved plan, no secret input.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../worker/services/command-runner.js';
import { OperationCancelled, OperationError } from '../worker/errors.js';
import { engineResult } from './result.js';
import { imageVersions, templatesCommit } from './versions.js';

const DEFAULT_MODULE = fileURLToPath(new URL('../../../../infra/pulumi/tenant/', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const managed = resource => resource.custom && !resource.type?.startsWith('pulumi:providers:');
export function pulumiStackName(input) { return `${input.base.project_name}-${input.tenant_id}-${input.env}`; }

export function summarizePulumiPreview(raw) {
  if (!raw || !Array.isArray(raw.steps))
    throw new OperationError('ENGINE_OUTPUT', 'Pulumi no devolvió una vista previa JSON reconocida.');
  const totals = { create: 0, update: 0, delete: 0, replace: 0 };
  const deleted = [];
  const lines = [];
  for (const step of raw.steps) {
    const type = step.type ?? step.newState?.type ?? step.oldState?.type;
    const urn = step.urn ?? step.newState?.urn ?? step.oldState?.urn;
    if (!type || typeof urn !== 'string' || typeof step.op !== 'string')
      throw new OperationError('ENGINE_OUTPUT', 'Pulumi devolvió un paso de plan incompleto.');
    if (type.startsWith('pulumi:')) continue;
    const op = step.op;
    if (op === 'create') totals.create++;
    else if (op === 'update') totals.update++;
    else if (op === 'delete') totals.delete++;
    else if (op === 'replace') totals.replace++;
    // Includes the detailed replacement step variants; fail closed for EBS replacement.
    if (type === 'aws:ebs/volume:Volume' && /delete|replace/.test(op)) deleted.push(urn);
    if (!['same', 'read', 'read-replacement'].includes(op)) lines.push(`${op}: ${urn.split('::').at(-1)} (${type})`);
  }
  return { totals, lines, data_volumes_deleted: [...new Set(deleted)], warnings: [] };
}

// Deliberately allowlist exported fields; never expose arbitrary stack outputs.
export function pulumiOutputs(raw) {
  if (!raw || typeof raw !== 'object' || !raw.instance_ids || !raw.db_volume_id)
    throw new OperationError('ENGINE_OUTPUT', 'El stack Pulumi no tiene los outputs del tenant.');
  return Object.fromEntries(['urls', 'instance_ids', 'private_ips', 'db_volume_id', 'ssm_prefix', 'suspended']
    .map(key => [key, raw[key]]));
}

export function createPulumiAdapter(config, { commandRunner = runCommand } = {}) {
  const moduleDir = config.IAC_PULUMI_DIR || DEFAULT_MODULE;
  const bin = config.PULUMI_BIN || 'pulumi';
  const js = /\.m?js$/i.test(bin);
  function paths(ctx) {
    for (const value of [ctx.input.tenant_id, ctx.input.env])
      if (!/^[a-zA-Z0-9_-]+$/.test(value ?? '')) throw new OperationError('IAC_INPUT', 'Identidad de tenant Pulumi inválida.');
    const stack = ctx.backend?.stack_name ?? pulumiStackName(ctx.input);
    if (!/^[a-zA-Z0-9_.-]+$/.test(stack)) throw new OperationError('IAC_INPUT', 'Nombre de stack Pulumi inválido.');
    const workspace = resolve(ctx.directory ?? join(config.IAC_RUNS_DIR, ctx.input.tenant_id, ctx.input.env, 'pulumi'));
    const backend = ctx.backend?.url ?? config.PULUMI_BACKEND_URL ??
      ((ctx.backend?.bucket ?? config.IAC_STATE_BUCKET) ? `s3://${ctx.backend?.bucket ?? config.IAC_STATE_BUCKET}/pulumi` : null);
    if (!backend || !/^(s3|file):\/\//.test(backend))
      throw new OperationError('IAC_CONFIG', 'Configura IAC_STATE_BUCKET o PULUMI_BACKEND_URL (s3:// o file://).');
    return { workspace, stack, backend, input: join(workspace, 'tenant-input.json'),
      plan: join(workspace, 'current.pulumi-plan.json') };
  }
  function env(ctx, p) {
    return {
      PULUMI_BACKEND_URL: p.backend, PULUMI_SKIP_UPDATE_CHECK: 'true', PULUMI_SKIP_CONFIRMATIONS: 'true',
      PULUMI_ENABLE_STREAMING_JSON_PREVIEW: 'false', PULUMI_CONFIG: '{}',
      PULUMI_CONFIG_PASSPHRASE: config.PULUMI_CONFIG_PASSPHRASE ?? process.env.PULUMI_CONFIG_PASSPHRASE,
      ATTENDANCE_PULUMI_INPUT: p.input, AWS_REGION: ctx.input.base.region, AWS_DEFAULT_REGION: ctx.input.base.region,
      ...(config.AWS_PROFILE ? { AWS_PROFILE: config.AWS_PROFILE } : {}),
    };
  }
  async function cli(ctx, p, args, { capture = false, mutation = false } = {}) {
    const controller = new AbortController();
    let cancelled = false;
    const forward = () => {
      if (mutation && ctx.signal.reason instanceof OperationCancelled) cancelled = true;
      else controller.abort(ctx.signal.reason);
    };
    ctx.signal?.throwIfAborted();
    ctx.signal?.addEventListener('abort', forward, { once: true });
    try {
      const result = await commandRunner({ command: js ? process.execPath : bin,
        args: [...(js ? [bin] : []), ...args, '--non-interactive', '--color', 'never'], cwd: p.workspace,
        env: env(ctx, p), signal: controller.signal, timeoutMs: (config.IAC_TIMEOUT_S ?? 3600) * 1000,
        killGraceMs: mutation ? 60000 : 5000, captureStdout: capture, logStdout: !capture,
        onLine: async (line, stream) => {
          if (cancelled) return;
          try { await ctx.report(line, { level: stream === 'stderr' ? 'warning' : 'info' }); }
          catch (error) { if (mutation && error instanceof OperationCancelled) cancelled = true; else throw error; }
        },
      });
      if (cancelled) throw new OperationCancelled();
      return result;
    } catch (error) {
      if (error.code === 'COMMAND_FAILED') throw new OperationError('ENGINE_FAILED', 'Pulumi falló. Revisa los eventos filtrados de la operación y el bloqueo del stack antes de reintentar.');
      if (error.code === 'COMMAND_NOT_FOUND') throw new OperationError('COMMAND_NOT_FOUND', 'No se encontró Pulumi. Instálalo o configura PULUMI_BIN.');
      throw error;
    } finally { ctx.signal?.removeEventListener('abort', forward); }
  }
  function json(text) {
    try { return JSON.parse(text); }
    catch { throw new OperationError('ENGINE_OUTPUT', 'Pulumi devolvió JSON inválido.'); }
  }
  async function prepare(ctx, { install = true } = {}) {
    const p = paths(ctx);
    if (!(config.PULUMI_CONFIG_PASSPHRASE ?? process.env.PULUMI_CONFIG_PASSPHRASE))
      throw new OperationError('IAC_CONFIG', 'Configura PULUMI_CONFIG_PASSPHRASE en el entorno local del worker; no se guarda en el estado.');
    await mkdir(p.workspace, { recursive: true, mode: 0o700 });
    for (const name of ['Pulumi.yaml', 'package.json', 'package-lock.json', 'index.js']) {
      try { await copyFile(join(moduleDir, name), join(p.workspace, name)); }
      catch { throw new OperationError('IAC_CONFIG', 'No se encontró el proyecto Pulumi completo. Revisa IAC_PULUMI_DIR.'); }
    }
    // Avoid accidental propagation of future secret-bearing properties from callers.
    const input = Object.fromEntries(['tenant_id', 'env', 'name', 'plan', 'contact_email', 'timezone', 'sizing',
      'limits', 'backup', 'ami', 'base', 'suspended'].map(key => [key, ctx.input[key]]));
    await writeFile(p.input, JSON.stringify(input), { mode: 0o600 });
    if (install) {
      // The installed lock digest prevents stale provider dependencies after upgrades.
      const stamp = join(p.workspace, '.dependencies.sha256');
      const wanted = digest(await readFile(join(moduleDir, 'package-lock.json'), 'utf8'));
      let current; try { current = await readFile(stamp, 'utf8'); } catch { /* first install */ }
      if (current !== wanted) {
        await commandRunner({ command: process.execPath, args: [config.NPM_CLI_JS || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: p.workspace, env: env(ctx, p), signal: ctx.signal,
          timeoutMs: (config.IAC_TIMEOUT_S ?? 3600) * 1000, onLine: line => ctx.report(line) });
        await writeFile(stamp, wanted);
      }
    }
    return p;
  }
  async function select(ctx, p, { create = false } = {}) {
    // --create is atomic and only creates stack metadata, never AWS resources.
    await cli(ctx, p, ['stack', 'select', p.stack, ...(create ? ['--create', '--secrets-provider', 'passphrase'] : [])]);
  }
  async function versions(ctx, p) {
    const version = await cli(ctx, p, ['version'], { capture: true });
    const pkg = json(await readFile(join(moduleDir, 'package.json'), 'utf8'));
    return { engine: 'pulumi', pulumi: version.stdout.trim(), provider_aws: pkg.dependencies['@pulumi/aws'],
      templates_commit: await templatesCommit(moduleDir), module: 'infra/pulumi/tenant', ...imageVersions(ctx.input) };
  }
  async function preview(ctx, p) {
    await rm(p.plan, { force: true });
    const output = await cli(ctx, p, ['preview', '--stack', p.stack, '--json', '--save-plan', p.plan], { capture: true });
    return summarizePulumiPreview(json(output.stdout));
  }
  async function destruction(ctx, p) {
    const output = await cli(ctx, p, ['stack', 'export', '--stack', p.stack], { capture: true });
    const state = json(output.stdout);
    if (!Array.isArray(state.deployment?.resources)) throw new OperationError('ENGINE_OUTPUT', 'Estado Pulumi incompleto.');
    const resources = state.deployment.resources;
    const selected = resources.filter(managed);
    return { stack_name: p.stack, fingerprint: digest({ stack: p.stack, backend: p.backend, resources }),
      totals: { create: 0, update: 0, delete: selected.length, replace: 0 },
      lines: selected.map(item => `delete: ${item.urn.split('::').at(-1)} (${item.type})`),
      data_volumes_deleted: selected.filter(item => item.type === 'aws:ebs/volume:Volume').map(item => item.urn), warnings: [] };
  }
  async function outputs(ctx, p) {
    const output = await cli(ctx, p, ['stack', 'output', '--stack', p.stack, '--json'], { capture: true });
    return { ...pulumiOutputs(json(output.stdout)), stack_name: p.stack };
  }
  async function run(ctx, { destroy = false, expectedPreview } = {}) {
    const p = await prepare(ctx);
    try {
      await select(ctx, p, { create: !destroy });
      const toolVersions = await versions(ctx, p);
      const summary = destroy ? await destruction(ctx, p) : await preview(ctx, p);
      if (destroy && (!expectedPreview || expectedPreview.stack_name !== p.stack || expectedPreview.fingerprint !== summary.fingerprint))
        throw new OperationError('IAC_PREVIEW_CHANGED', 'Genera otra vista previa: el estado o identidad Pulumi cambió antes de eliminar.');
      if (!destroy && summary.data_volumes_deleted.length)
        throw new OperationError('DATA_LOSS_BLOCKED', 'El plan Pulumi eliminaría o reemplazaría el disco PostgreSQL. Se detuvo sin aplicar cambios.');
      for (const line of summary.lines) await ctx.report(line);
      await ctx.report(destroy ? 'Eliminando recursos del tenant.' : 'Aplicando el plan Pulumi revisado.', { stage: 'Aplicando cambios', progress: 50 });
      await cli(ctx, p, destroy ? ['destroy', '--stack', p.stack, '--yes', '--skip-preview', '--suppress-outputs']
        : ['up', '--stack', p.stack, '--yes', '--skip-preview', '--plan', p.plan, '--suppress-outputs'], { mutation: true });
      const result = destroy ? {} : await outputs(ctx, p);
      return { ...engineResult({ outputs: result, toolVersions, logRef: ctx.logRef }), preview: summary };
    } finally { await rm(p.plan, { force: true }); }
  }
  return { engine: 'pulumi', label: 'Pulumi',
    async preflight(ctx) { const p = await prepare(ctx, { install: false }); await cli(ctx, p, ['version'], { capture: true }); },
    async versions(ctx) { const p = await prepare(ctx, { install: false }); return versions(ctx, p); },
    async preview(ctx, { destroy = false } = {}) { const p = await prepare(ctx); try {
      await select(ctx, p, { create: !destroy }); return destroy ? await destruction(ctx, p) : await preview(ctx, p);
    } finally { await rm(p.plan, { force: true }); } },
    apply: ctx => run(ctx), suspend: ctx => run({ ...ctx, input: { ...ctx.input, suspended: true } }),
    resume: ctx => run({ ...ctx, input: { ...ctx.input, suspended: false } }),
    destroy: (ctx, options) => run(ctx, { ...options, destroy: true }),
    async outputs(ctx) { const p = await prepare(ctx, { install: false }); await select(ctx, p); return outputs(ctx, p); },
  };
}
