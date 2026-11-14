// Adaptador Terraform / OpenTofu (D2, P2). Ejecuta el módulo infra/terraform/tenant de P1
// con el estado propio del tenant: s3://<bucket>/tenants/<tenant_id>/<env>/terraform.tfstate.
//
// Cada tenant/entorno tiene su directorio de ejecución (IAC_RUNS_DIR/<tenant>/<env>/) con
// una copia de los .tf del módulo, su .terraform/, sus variables y su plan. Así terraform y
// tofu no comparten caché ni lockfile con el checkout ni con otros tenants.
//
// Los procesos se ejecutan con el ejecutor común de P6 (worker/services/command-runner.js):
// argumentos separados, logs filtrados, timeout y cancelación del árbol de procesos.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../worker/services/command-runner.js';
import { OperationCancelled, OperationError } from '../worker/errors.js';
import { explainEngineError } from './errors.js';
import { engineResult } from './result.js';

const exec = promisify(execFile);
const LOCK_TIMEOUT = '-lock-timeout=5m';
const PROVIDER_KEYS = [
  'registry.terraform.io/hashicorp/aws',
  'registry.opentofu.org/hashicorp/aws',
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Variables que acepta infra/terraform/tenant (variables.tf). */
export function moduleVariables(input, config) {
  return {
    base: input.base,
    tenant_id: input.tenant_id,
    env: input.env,
    name: input.name,
    contact_email: input.contact_email,
    timezone: input.timezone,
    plan: input.plan,
    engine: input.engine,
    suspended: input.suspended,
    sizing: input.sizing,
    ami: input.ami,
    limits: input.limits,
    backup: input.backup,
    cloud_init_template_path: config.IAC_CLOUD_INIT_TEMPLATE.replaceAll('\\', '/'),
  };
}

export function stateKey(input) {
  return `tenants/${input.tenant_id}/${input.env}/terraform.tfstate`;
}

export function backendConfig(input, config) {
  return [
    `bucket       = ${JSON.stringify(config.IAC_STATE_BUCKET)}`,
    `key          = ${JSON.stringify(stateKey(input))}`,
    `region       = ${JSON.stringify(input.base.region)}`,
    'encrypt      = true',
    'use_lockfile = true',
    '',
  ].join('\n');
}

/** "Plan: 9 to add, 0 to change, 0 to destroy." → { add, change, destroy } */
export function parsePlanLine(line) {
  const match = /Plan: (\d+) to add, (\d+) to change, (\d+) to destroy/.exec(line);
  return match
    ? { add: Number(match[1]), change: Number(match[2]), destroy: Number(match[3]) }
    : null;
}

/** Aplana `output -json` ({name: {value, sensitive}}) omitiendo los sensibles. */
export function flattenOutputs(raw) {
  const outputs = {};
  for (const [name, item] of Object.entries(raw ?? {}))
    if (!item?.sensitive) outputs[name] = item?.value ?? null;
  return outputs;
}

// Un script .js/.mjs (CLI simulado de las pruebas) se ejecuta con el mismo Node.
function resolveCommand(bin) {
  return /\.m?js$/i.test(bin)
    ? { command: process.execPath, prefix: [bin] }
    : { command: bin, prefix: [] };
}

export function createTerraformAdapter(config, engine) {
  const tofu = engine === 'tofu';
  const bin = tofu ? config.TOFU_BIN : config.TERRAFORM_BIN;
  const label = tofu ? 'OpenTofu' : 'Terraform';
  const { command, prefix } = resolveCommand(bin);
  const timeoutMs = config.IAC_TIMEOUT_S * 1000;

  function paths(input) {
    const runDir = join(config.IAC_RUNS_DIR, input.tenant_id, input.env);
    return {
      runDir,
      moduleDir: join(runDir, 'module'),
      varFile: join(runDir, 'tenant.tfvars.json'),
      backendFile: join(runDir, 'backend.hcl'),
      planFile: join(runDir, 'current.tfplan'),
      cacheDir: join(config.IAC_RUNS_DIR, '.plugin-cache', engine),
    };
  }

  function env(p) {
    const extra = {
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      CHECKPOINT_DISABLE: '1',
      TF_PLUGIN_CACHE_DIR: p.cacheDir,
    };
    // plan_preview.py invoca "terraform"/"tofu" por nombre: se antepone la carpeta del binario.
    if (isAbsolute(bin) && !prefix.length)
      extra.PATH = `${dirname(bin)}${delimiter}${process.env.PATH ?? ''}`;
    return extra;
  }

  // Copia los .tf del módulo de P1 (siempre, para tomar sus cambios) y su lockfile. El
  // proveedor usa la dirección completa registry.terraform.io/hashicorp/aws, así que
  // Terraform y OpenTofu comparten el mismo lockfile versionado.
  async function prepare(ctx) {
    const { input } = ctx;
    if (!config.IAC_STATE_BUCKET)
      throw new OperationError(
        'IAC_CONFIG',
        'Configura IAC_STATE_BUCKET (bucket del estado creado en infra/bootstrap) en el .env del worker.',
      );
    if (!(await exists(config.IAC_CLOUD_INIT_TEMPLATE)))
      throw new OperationError(
        'IAC_CONFIG',
        'No se encontró la plantilla cloud-init. Revisa IAC_CLOUD_INIT_TEMPLATE.',
      );
    const p = paths(input);
    await mkdir(p.moduleDir, { recursive: true });
    await mkdir(p.cacheDir, { recursive: true });
    let sources = [];
    try {
      sources = (await readdir(config.IAC_MODULE_DIR)).filter((file) => file.endsWith('.tf'));
    } catch {
      /* se informa abajo */
    }
    if (!sources.length)
      throw new OperationError('IAC_CONFIG', 'No se encontró el módulo tenant. Revisa IAC_MODULE_DIR.');
    for (const file of await readdir(p.moduleDir))
      if (file.endsWith('.tf') && !sources.includes(file))
        await rm(join(p.moduleDir, file));
    for (const file of sources)
      await copyFile(join(config.IAC_MODULE_DIR, file), join(p.moduleDir, file));
    const lock = join(config.IAC_MODULE_DIR, '.terraform.lock.hcl');
    if (await exists(lock)) await copyFile(lock, join(p.moduleDir, '.terraform.lock.hcl'));
    await writeFile(p.varFile, `${JSON.stringify(moduleVariables(input, config), null, 2)}\n`);
    await writeFile(p.backendFile, backendConfig(input, config));
    return p;
  }

  /**
   * Ejecuta el CLI. Cada línea va a los eventos (salvo stdout de comandos -json, que el
   * ejecutor nunca registra). Un código de salida distinto de 0 se traduce con stderr.
   */
  async function cli(ctx, p, args, { capture = false, signal = ctx.signal, onLine, killGraceMs } = {}) {
    const stderrTail = [];
    const report =
      onLine ??
      ((line, stream) => ctx.report(line, { level: stream === 'stderr' ? 'warning' : 'info' }));
    try {
      return await runCommand({
        command,
        args: [...prefix, `-chdir=${p.moduleDir}`, ...args],
        env: env(p),
        signal,
        timeoutMs,
        killGraceMs,
        captureStdout: capture,
        logStdout: !capture,
        onLine: async (line, stream) => {
          if (stream === 'stderr') {
            stderrTail.push(line);
            if (stderrTail.length > 60) stderrTail.shift();
          }
          await report(line, stream);
        },
      });
    } catch (error) {
      if (error.code === 'COMMAND_FAILED')
        throw new OperationError('ENGINE_FAILED', explainEngineError(stderrTail, label));
      if (error.code === 'COMMAND_NOT_FOUND')
        throw new OperationError(
          error.code,
          `No se encontró ${label}. Instálalo o configura ${tofu ? 'TOFU_BIN' : 'TERRAFORM_BIN'}.`,
        );
      throw error;
    }
  }

  async function init(ctx, p) {
    await ctx.report(`${label} init: proveedor AWS y estado ${stateKey(ctx.input)}.`, {
      stage: `Inicializando ${label}`,
      progress: 15,
    });
    await cli(ctx, p, ['init', '-input=false', '-no-color', '-reconfigure', `-backend-config=${p.backendFile}`]);
  }

  async function plan(ctx, p, { destroy = false } = {}) {
    await ctx.report(
      destroy ? 'Calculando qué se eliminará.' : 'Calculando los cambios del tenant.',
      { stage: destroy ? 'Planificando la eliminación' : 'Planificando cambios', progress: 30 },
    );
    let counts = null;
    await cli(
      ctx,
      p,
      [
        'plan',
        '-input=false',
        '-no-color',
        LOCK_TIMEOUT,
        `-var-file=${p.varFile}`,
        `-out=${p.planFile}`,
        ...(destroy ? ['-destroy'] : []),
      ],
      {
        onLine: (line, stream) => {
          counts = parsePlanLine(line) ?? counts;
          if (/^No changes\./.test(line)) counts = { add: 0, change: 0, destroy: 0 };
          return ctx.report(line, { level: stream === 'stderr' ? 'warning' : 'info' });
        },
      },
    );
    return counts;
  }

  // Resumen de P1 (infra/terraform/plan_preview.py): destaca reemplazos y pérdida de datos.
  // Es opcional: si Python no está disponible se continúa con el conteo del plan.
  async function summarize(ctx, p) {
    try {
      const python = resolveCommand(config.PYTHON_BIN);
      const result = await runCommand({
        command: python.command,
        args: [
          ...python.prefix,
          config.IAC_PLAN_PREVIEW,
          '--directory',
          p.moduleDir,
          '--plan',
          p.planFile,
          '--engine',
          engine,
          '--output',
          'json',
        ],
        env: env(p),
        signal: ctx.signal,
        timeoutMs: 120000,
        captureStdout: true,
        logStdout: false,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      if (error.code === 'COMMAND_CANCELLED' || ctx.signal?.aborted) throw error;
      return null;
    }
  }

  // Cancelar desde la UI no corta un apply en curso: se espera a que termine el paso y
  // luego se marca la operación como cancelada. La pérdida de la operación o el apagado
  // del worker sí detienen el proceso (con 60 s de gracia para liberar el bloqueo).
  async function applyPlan(ctx, p) {
    ctx.signal?.throwIfAborted();
    const controller = new AbortController();
    let cancelled = false;
    const forward = () => {
      if (ctx.signal.reason instanceof OperationCancelled) cancelled = true;
      else controller.abort(ctx.signal.reason);
    };
    ctx.signal?.addEventListener('abort', forward, { once: true });
    try {
      await cli(ctx, p, ['apply', '-input=false', '-no-color', LOCK_TIMEOUT, p.planFile], {
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
    const result = await cli(ctx, p, ['output', '-json', '-no-color'], { capture: true });
    try {
      return flattenOutputs(JSON.parse(result.stdout || '{}'));
    } catch {
      throw new OperationError('ENGINE_OUTPUT', `${label} devolvió outputs que no son JSON.`);
    }
  }

  async function versions(ctx, p) {
    const toolVersions = { engine };
    try {
      const result = await cli(ctx, p, ['version', '-json'], { capture: true });
      const data = JSON.parse(result.stdout);
      toolVersions[engine] = data.terraform_version ?? data.version ?? null;
      const providers = data.provider_selections ?? {};
      toolVersions.provider_aws = PROVIDER_KEYS.map((key) => providers[key]).find(Boolean) ?? null;
    } catch (error) {
      if (error.code === 'COMMAND_CANCELLED' || ctx.signal?.aborted) throw error;
      toolVersions[engine] = null;
    }
    // Commit de las plantillas usadas (módulo + cloud-init); "-dirty" si hay cambios locales.
    try {
      const cwd = config.IAC_MODULE_DIR;
      const { stdout: commit } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
      const { stdout: dirty } = await exec(
        'git',
        ['status', '--porcelain', '--', '.', dirname(config.IAC_CLOUD_INIT_TEMPLATE)],
        { cwd },
      );
      toolVersions.templates_commit = `${commit.trim()}${dirty.trim() ? '-dirty' : ''}`;
    } catch {
      toolVersions.templates_commit = null;
    }
    toolVersions.image_version = ctx.input.image?.version ?? null;
    toolVersions.image_git_commit = ctx.input.image?.git_commit ?? null;
    toolVersions.module = 'infra/terraform/tenant';
    return toolVersions;
  }

  // Flujo común: preparar → init → plan → revisar → apply → outputs.
  async function run(ctx, { destroy = false } = {}) {
    await ctx.report(`Motor ${label}. Directorio de ejecución del tenant listo.`, {
      stage: 'Preparando el directorio del tenant',
      progress: 10,
    });
    const p = await prepare(ctx);
    await init(ctx, p);
    const toolVersions = await versions(ctx, p);
    const counts = await plan(ctx, p, { destroy });
    const preview = await summarize(ctx, p);
    if (preview?.data_volumes_deleted?.length && !destroy)
      throw new OperationError(
        'DATA_LOSS_BLOCKED',
        'El plan eliminaría el disco de datos de PostgreSQL y esta operación no es una eliminación. Se detuvo sin aplicar cambios.',
      );
    for (const warning of preview?.warnings ?? [])
      await ctx.report(`Aviso del plan: ${warning}`, { level: 'warning' });
    const totals = preview?.totals ?? counts;
    await ctx.report(
      totals
        ? `Plan: crear ${totals.add ?? totals.create ?? 0}, modificar ${totals.change ?? totals.update ?? 0}, eliminar ${totals.destroy ?? totals.delete ?? 0}.`
        : 'Plan calculado.',
      { stage: 'Plan revisado', progress: 45 },
    );
    const nothingToDo = counts && counts.add + counts.change + counts.destroy === 0;
    if (nothingToDo)
      await ctx.report('Sin cambios: la infraestructura ya coincide con lo solicitado.', {
        stage: 'Sin cambios pendientes',
        progress: 75,
      });
    else {
      await ctx.report(
        'Aplicando el plan. Una cancelación se atiende al terminar este paso para no dejar el estado a medias.',
        { stage: destroy ? 'Eliminando recursos' : 'Aplicando cambios', progress: 50 },
      );
      await applyPlan(ctx, p);
    }
    await rm(p.planFile, { force: true });
    const outputs = destroy ? {} : await readOutputs(ctx, p);
    await ctx.report(
      destroy ? 'Recursos del tenant eliminados.' : 'Outputs del despliegue leídos.',
      { stage: destroy ? 'Recursos eliminados' : 'Infraestructura aplicada', progress: 80 },
    );
    return { ...engineResult({ outputs, toolVersions, logRef: ctx.logRef }), preview };
  }

  return {
    engine,
    label,
    async versions(ctx) {
      const p = await prepare(ctx);
      await init(ctx, p);
      return versions(ctx, p);
    },
    async preview(ctx, { destroy = false } = {}) {
      const p = await prepare(ctx);
      await init(ctx, p);
      const counts = await plan(ctx, p, { destroy });
      const preview = await summarize(ctx, p);
      await rm(p.planFile, { force: true });
      return preview ?? { totals: counts };
    },
    apply: (ctx) => run(ctx),
    suspend: (ctx) => run({ ...ctx, input: { ...ctx.input, suspended: true } }),
    resume: (ctx) => run({ ...ctx, input: { ...ctx.input, suspended: false } }),
    destroy: (ctx) => run(ctx, { destroy: true }),
    async outputs(ctx) {
      const p = await prepare(ctx);
      await init(ctx, p);
      return readOutputs(ctx, p);
    },
  };
}
