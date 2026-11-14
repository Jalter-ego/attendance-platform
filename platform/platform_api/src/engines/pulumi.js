// Adaptador Pulumi (D3, P2). Ejecuta el programa infra/pulumi/tenant (JavaScript, el mismo
// lenguaje del backend) con un stack por tenant y entorno en el backend S3 compartido:
//   s3://<IAC_STATE_BUCKET>/pulumi  →  organization/attendance-tenant/<tenant_id>-<env>
//
// Cada tenant tiene su directorio de ejecución (IAC_RUNS_DIR/<tenant>/<env>/pulumi) con un
// Pulumi.yaml generado (main → el programa del repo) y su Pulumi.<stack>.yaml (sal del
// cifrado y configuración). Así no se escriben archivos del tenant dentro del repositorio.
//
// Los procesos usan el ejecutor común de P6 (argumentos separados, logs filtrados, timeout y
// cancelación del árbol). La entrada del tenant llega por stdin a `pulumi config set`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../worker/services/command-runner.js';
import { OperationCancelled, OperationError } from '../worker/errors.js';
import { explainEngineError } from './errors.js';
import { engineResult } from './result.js';
import { imageVersions, templatesCommit } from './versions.js';

export const PROJECT = 'attendance-tenant';
const LABEL = 'Pulumi';
// Errores de la CLI: la salida en modo --json devuelve código 255 con los diagnósticos.
const JSON_EXIT_CODES = [0, 1, 255];
const VOLUME = 'aws:ebs/volume:Volume';
const REPLACING = new Set(['replace', 'create-replacement', 'delete-replaced']);
const OP_LABELS = { create: 'Se creará', update: 'Se modificará', delete: 'Se eliminará', replace: 'Se reemplazará' };

export const stackName = (input) => `${input.tenant_id}-${input.env}`;
export const qualifiedStack = (input) => `organization/${PROJECT}/${stackName(input)}`;

/** Backend DIY de Pulumi: prefijo propio `pulumi/` en el bucket de estado de P1. */
export function backendUrl(config, input) {
  if (config.PULUMI_BACKEND_URL) return config.PULUMI_BACKEND_URL;
  const bucket = config.PLATFORM_STATE_BUCKET || config.IAC_STATE_BUCKET;
  return bucket ? `s3://${bucket}/pulumi?region=${config.PLATFORM_STATE_REGION || input.base.region}` : null;
}

/** Entrada del programa (la misma de Terraform). Sin secretos: viven en SSM. */
export function programInput(input) {
  const { image, ...rest } = input;
  return { ...rest, engine: 'pulumi' };
}

// urn:pulumi:<stack>::<project>::<type>::<name>
const urnParts = (urn) => {
  const parts = String(urn).split('::');
  return { type: parts[2]?.split('$').at(-1) ?? '', name: parts[3] ?? '' };
};
const managed = (type) => type && !type.startsWith('pulumi:');

/** Resume `pulumi preview --json`: conteos, líneas legibles y si se perdería el disco de datos. */
export function summarizePreview(preview) {
  const byUrn = new Map();
  for (const step of preview?.steps ?? []) {
    const { type, name } = urnParts(step.urn);
    if (!managed(type) || ['same', 'read', 'refresh', 'discard'].includes(step.op)) continue;
    const op = REPLACING.has(step.op) ? 'replace' : step.op;
    if (!OP_LABELS[op]) continue;
    const previous = byUrn.get(step.urn);
    if (!previous || op === 'replace') byUrn.set(step.urn, { op, type, name });
  }
  const changes = [...byUrn.values()];
  const totals = { create: 0, update: 0, delete: 0, replace: 0 };
  for (const { op } of changes) totals[op] += 1;
  return {
    totals,
    lines: changes.map(({ op, type, name }) => `${OP_LABELS[op]}: ${type.split(':').at(-1)} ${name}`),
    data_volumes_deleted: changes
      .filter(({ op, type }) => type === VOLUME && (op === 'delete' || op === 'replace'))
      .map(({ name }) => name),
  };
}

/** Recursos administrados de `pulumi stack export` y su huella (para confirmar la eliminación). */
export function stackInventory(exported) {
  const resources = (exported?.deployment?.resources ?? [])
    .map((resource) => ({ ...urnParts(resource.urn), urn: resource.urn, id: resource.id ?? null }))
    .filter(({ type }) => managed(type));
  const fingerprint = createHash('sha256')
    .update(resources.map(({ urn, id }) => `${urn}=${id}`).sort().join('\n'))
    .digest('hex');
  return { resources, fingerprint };
}

/** Mensaje comprensible desde la salida de Pulumi ("error: ..." en minúsculas). */
export function explainPulumiError(lines) {
  const text = lines.join('\n');
  if (/stack is currently locked|currently locked by/i.test(text))
    return 'Otra ejecución tiene bloqueado el stack Pulumi de este tenant. Espera a que termine; si se interrumpió, un responsable debe revisar el bloqueo (pulumi cancel / stack export) antes de reintentar.';
  if (/passphrase|PULUMI_CONFIG_PASSPHRASE|failed to decrypt/i.test(text))
    return 'No se pudo abrir el cifrado del stack Pulumi. Revisa PULUMI_CONFIG_PASSPHRASE o PULUMI_SECRETS_PROVIDER del worker.';
  if (/marked for protection|resource .* is protected|protected resource/i.test(text))
    return 'El cambio eliminaría o reemplazaría el disco de datos protegido de PostgreSQL. Se detuvo sin perder datos.';
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(text))
    return 'Faltan las dependencias del programa Pulumi. Ejecuta: pnpm --dir infra/pulumi/tenant install.';
  return explainEngineError(lines.map((line) => line.replace(/^\s*error:\s+/i, 'Error: ')), LABEL);
}

// Un script .js/.mjs (CLI simulado de las pruebas) se ejecuta con el mismo Node.
function resolveCommand(bin) {
  return /\.m?js$/i.test(bin) ? { command: process.execPath, prefix: [bin] } : { command: bin, prefix: [] };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function createPulumiAdapter(config) {
  const { command, prefix } = resolveCommand(config.PULUMI_BIN || 'pulumi');
  const timeoutMs = (config.IAC_TIMEOUT_S ?? 3600) * 1000;
  const programDir = config.IAC_PULUMI_DIR;
  const provider = config.PULUMI_SECRETS_PROVIDER || 'passphrase';
  const passphrase = provider === 'passphrase' ? config.PULUMI_CONFIG_PASSPHRASE ?? '' : undefined;

  function env(input) {
    return {
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      AWS_REGION: input.base.region,
      ...(passphrase === undefined ? {} : { PULUMI_CONFIG_PASSPHRASE: passphrase }),
    };
  }

  async function prepare(ctx) {
    const { input } = ctx;
    const url = ctx.backend?.url ?? backendUrl(config, input);
    if (!url)
      throw new OperationError('IAC_CONFIG', 'Configura IAC_STATE_BUCKET (o PULUMI_BACKEND_URL) para guardar el estado de Pulumi.');
    if (provider === 'passphrase' && !passphrase)
      throw new OperationError('IAC_CONFIG', 'Configura PULUMI_CONFIG_PASSPHRASE (o PULUMI_SECRETS_PROVIDER=awskms://...) en el .env del worker.');
    if (!(await exists(join(programDir, 'index.js'))))
      throw new OperationError('IAC_CONFIG', 'No se encontró el programa Pulumi. Revisa IAC_PULUMI_DIR.');
    if (!(await exists(join(programDir, 'node_modules', '@pulumi', 'aws'))))
      throw new OperationError('IAC_CONFIG', 'Faltan las dependencias del programa Pulumi. Ejecuta: pnpm --dir infra/pulumi/tenant install.');
    const dir = ctx.directory ?? join(config.IAC_RUNS_DIR, input.tenant_id, input.env, 'pulumi');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // JSON es YAML válido. `main` permite ejecutar el programa del repo desde este directorio.
    const project = {
      name: PROJECT,
      runtime: { name: 'nodejs' },
      main: programDir.replaceAll('\\', '/'),
      backend: { url },
    };
    await writeFile(join(dir, 'Pulumi.yaml'), `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
    return { dir, url, stack: qualifiedStack(input) };
  }

  /** Ejecuta la CLI. stdout de comandos --json se captura en privado y nunca se registra. */
  async function cli(ctx, p, args, { capture = false, input, signal = ctx.signal, onLine, killGraceMs, acceptedExitCodes } = {}) {
    const tail = [];
    const report = onLine ?? ((line, stream) => ctx.report(line, { level: stream === 'stderr' ? 'warning' : 'info' }));
    try {
      return await runCommand({
        command,
        args: [...prefix, ...args, '--non-interactive', '--color', 'never'],
        cwd: p.dir,
        env: env(ctx.input),
        input,
        signal,
        timeoutMs,
        killGraceMs,
        acceptedExitCodes,
        captureStdout: capture,
        logStdout: !capture,
        secrets: passphrase ? [passphrase] : [],
        onLine: async (line, stream) => {
          tail.push(line);
          if (tail.length > 80) tail.shift();
          await report(line, stream);
        },
      });
    } catch (error) {
      if (error.code === 'COMMAND_FAILED') throw new OperationError('ENGINE_FAILED', explainPulumiError(tail));
      if (error.code === 'COMMAND_NOT_FOUND')
        throw new OperationError(error.code, 'No se encontró Pulumi. Instálalo o configura PULUMI_BIN.');
      throw error;
    }
  }

  function parseJson(result, what) {
    try {
      return JSON.parse(result.stdout || 'null');
    } catch {
      throw new OperationError('ENGINE_OUTPUT', `Pulumi devolvió ${what} que no es JSON.`);
    }
  }

  async function selectStack(ctx, p, { create = true } = {}) {
    await ctx.report(`Pulumi: stack ${stackName(ctx.input)} en el backend compartido.`, { stage: 'Inicializando Pulumi', progress: 15 });
    await cli(ctx, p, ['stack', 'select', p.stack, ...(create ? ['--create', '--secrets-provider', provider] : [])]);
  }

  async function configure(ctx, p) {
    // Por stdin: la configuración no aparece en los argumentos del proceso.
    await cli(ctx, p, ['config', 'set', `${PROJECT}:input`, '--stack', p.stack], {
      input: JSON.stringify(programInput(ctx.input)),
    });
  }

  async function preview(ctx, p) {
    await ctx.report('Calculando los cambios del tenant (pulumi preview).', { stage: 'Planificando cambios', progress: 30 });
    const result = await cli(ctx, p, ['preview', '--json', '--stack', p.stack], {
      capture: true, acceptedExitCodes: JSON_EXIT_CODES,
    });
    const data = parseJson(result, 'una vista previa');
    if (result.exitCode !== 0) {
      const messages = (data?.diagnostics ?? [])
        .filter(({ severity }) => severity === 'error')
        .map(({ message }) => `error: ${String(message).trim()}`);
      throw new OperationError('ENGINE_FAILED', explainPulumiError(messages.length ? messages : ['error: la vista previa falló']));
    }
    return summarizePreview(data);
  }

  async function exportStack(ctx, p) {
    const result = await cli(ctx, p, ['stack', 'export', '--stack', p.stack], { capture: true });
    return stackInventory(parseJson(result, 'un estado'));
  }

  // Igual que Terraform: cancelar desde la UI espera al final del `up`/`destroy` para no
  // dejar el estado a medias; perder la operación o apagar el worker sí lo detiene.
  async function guarded(ctx, p, args) {
    ctx.signal?.throwIfAborted();
    const controller = new AbortController();
    let cancelled = false;
    const forward = () => {
      if (ctx.signal.reason instanceof OperationCancelled) cancelled = true;
      else controller.abort(ctx.signal.reason);
    };
    ctx.signal?.addEventListener('abort', forward, { once: true });
    try {
      await cli(ctx, p, args, {
        signal: controller.signal,
        killGraceMs: 60000,
        onLine: async (line, stream) => {
          if (cancelled) return;
          try {
            await ctx.report(line, { level: stream === 'stderr' ? 'warning' : 'info' });
          } catch (error) {
            if (error instanceof OperationCancelled) cancelled = true;
            else throw error;
          }
        },
      });
    } finally {
      ctx.signal?.removeEventListener('abort', forward);
    }
    if (cancelled) throw new OperationCancelled();
  }

  async function readOutputs(ctx, p) {
    const result = await cli(ctx, p, ['stack', 'output', '--json', '--stack', p.stack], { capture: true });
    return parseJson(result, 'outputs') ?? {};
  }

  async function versions(ctx, p) {
    const toolVersions = { engine: 'pulumi' };
    try {
      const result = await cli(ctx, p, ['version'], { capture: true });
      toolVersions.pulumi = result.stdout.trim().split(/\s+/)[0] || null;
    } catch (error) {
      if (error.code === 'COMMAND_CANCELLED' || ctx.signal?.aborted) throw error;
      toolVersions.pulumi = null;
    }
    try {
      const pkg = JSON.parse(await readFile(join(programDir, 'node_modules', '@pulumi', 'aws', 'package.json'), 'utf8'));
      toolVersions.provider_aws = pkg.version ?? null;
    } catch {
      toolVersions.provider_aws = null;
    }
    toolVersions.templates_commit = await templatesCommit(programDir, ['.']);
    Object.assign(toolVersions, imageVersions(ctx.input));
    toolVersions.module = 'infra/pulumi/tenant';
    return toolVersions;
  }

  // preparar → stack → configuración → preview → (bloqueo de pérdida de datos) → up → outputs.
  async function run(ctx) {
    await ctx.report('Motor Pulumi. Directorio de ejecución del tenant listo.', { stage: 'Preparando el directorio del tenant', progress: 10 });
    const p = await prepare(ctx);
    await selectStack(ctx, p);
    const toolVersions = await versions(ctx, p);
    await configure(ctx, p);
    const summary = await preview(ctx, p);
    if (summary.data_volumes_deleted.length)
      throw new OperationError('DATA_LOSS_BLOCKED',
        'El cambio eliminaría o reemplazaría el disco de datos de PostgreSQL y esta operación no es una eliminación. Se detuvo sin aplicar cambios.');
    const { totals } = summary;
    await ctx.report(`Plan: crear ${totals.create}, modificar ${totals.update}, reemplazar ${totals.replace}, eliminar ${totals.delete}.`, { stage: 'Plan revisado', progress: 45 });
    if (Object.values(totals).every((count) => count === 0)) {
      await ctx.report('Sin cambios: la infraestructura ya coincide con lo solicitado.', { stage: 'Sin cambios pendientes', progress: 75 });
    } else {
      await ctx.report('Aplicando los cambios (pulumi up). Una cancelación se atiende al terminar este paso.', { stage: 'Aplicando cambios', progress: 50 });
      await guarded(ctx, p, ['up', '--yes', '--skip-preview', '--suppress-progress', '--stack', p.stack]);
    }
    const outputs = await readOutputs(ctx, p);
    await ctx.report('Outputs del despliegue leídos.', { stage: 'Infraestructura aplicada', progress: 80 });
    return {
      ...engineResult({ outputs: { ...outputs, stack_name: p.stack }, toolVersions, logRef: ctx.logRef }),
      preview: summary,
    };
  }

  async function previewDestroy(ctx, p) {
    try {
      await selectStack(ctx, p, { create: false });
    } catch (error) {
      if (error.code === 'ENGINE_FAILED') return { stack: null, lines: [], resources: [], fingerprint: stackInventory(null).fingerprint };
      throw error;
    }
    const inventory = await exportStack(ctx, p);
    return {
      stack: p.stack,
      lines: inventory.resources.map(({ type, name }) => `Se eliminará: ${type.split(':').at(-1)} ${name}${type === VOLUME ? ' (disco de datos de PostgreSQL)' : ''}`),
      resources: inventory.resources.map(({ type, name, id }) => ({ type, name, id })),
      fingerprint: inventory.fingerprint,
    };
  }

  return {
    engine: 'pulumi',
    label: LABEL,
    async preflight(ctx) {
      const p = await prepare(ctx);
      // `pulumi version` no abre el backend ni habla con AWS: detecta la CLI antes de SSM.
      await cli(ctx, p, ['version'], { capture: true });
    },
    async versions(ctx) {
      const p = await prepare(ctx);
      return versions(ctx, p);
    },
    async preview(ctx, { destroy = false } = {}) {
      const p = await prepare(ctx);
      if (destroy) return previewDestroy(ctx, p);
      await selectStack(ctx, p);
      await configure(ctx, p);
      return preview(ctx, p);
    },
    apply: (ctx) => run(ctx),
    suspend: (ctx) => run({ ...ctx, input: { ...ctx.input, suspended: true } }),
    resume: (ctx) => run({ ...ctx, input: { ...ctx.input, suspended: false } }),
    async destroy(ctx, { expectedPreview } = {}) {
      const p = await prepare(ctx);
      const current = await previewDestroy(ctx, p);
      if (expectedPreview && expectedPreview.fingerprint !== current.fingerprint)
        throw new OperationError('IAC_PREVIEW_STALE', 'Los recursos del stack cambiaron desde la vista previa. Genera una nueva antes de eliminar.');
      const toolVersions = await versions(ctx, p);
      if (current.stack && current.resources.length) {
        await ctx.report(`Eliminando ${current.resources.length} recursos del stack ${stackName(ctx.input)}, incluido el disco de datos.`, { stage: 'Eliminando recursos', progress: 50 });
        // El disco está protegido contra updates; la eliminación confirmada lo libera.
        await cli(ctx, p, ['state', 'unprotect', '--all', '--yes', '--stack', p.stack]);
        await guarded(ctx, p, ['destroy', '--yes', '--skip-preview', '--suppress-progress', '--stack', p.stack]);
      }
      await ctx.report('Recursos del tenant eliminados.', { stage: 'Recursos eliminados', progress: 80 });
      return engineResult({ outputs: { stack_name: current.stack }, toolVersions, logRef: ctx.logRef });
    },
    async outputs(ctx) {
      const p = await prepare(ctx);
      await selectStack(ctx, p, { create: false });
      return readOutputs(ctx, p);
    },
  };
}
