// Pruebas de los adaptadores de motor (P2) sin AWS: terraform y aws se simulan con
// tests/fixtures/fake-terraform.mjs. Ejecutar con `pnpm test:engines`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { getAdapter, engineAvailable } from '../src/engines/adapter.js';
import { explainEngineError } from '../src/engines/errors.js';
import { waitForHealth } from '../src/engines/health.js';
import { BACKUP_BY_PLAN, buildTenantInput } from '../src/engines/tenant-input.js';
import { flattenOutputs, parsePlanLine } from '../src/engines/terraform.js';
import { LeaseLost, OperationCancelled, OperationError } from '../src/worker/errors.js';
import { assertCanEnqueue } from '../src/modules/provisioning/provisioning.service.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let dir;
let config;
let server;
let healthStatus = 200;
const tenant = {
  id: '00000000-0000-4000-8000-000000000001',
  tenant_id: 'demo-p2',
  name: 'Instituto Demo',
  env: 'test',
  region: 'us-east-2',
  plan: 'standard',
  engine: 'terraform',
  contact_email: 'admin@example.com',
  timezone: 'America/La_Paz',
  status: 'draft',
};
const plan = {
  code: 'standard',
  sizing: { frontend: 't3.micro', backend: 't3.small', db: 't3.small', db_disk_gb: 50 },
  limits: { max_students: 1000, max_teachers: 50, max_courses: 100 },
};
const base = {
  project_name: 'attendance-platform',
  region: 'us-east-2',
  availability_zone: 'us-east-2a',
  vpc_id: 'vpc-1',
  public_subnet_id: 'subnet-pub',
  private_subnet_id: 'subnet-priv',
  monitoring_security_group_id: 'sg-mon',
  ssm_endpoint_id: 'vpce-1',
  backups_bucket: 'backups-bucket',
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engines-test-'));
  await writeFile(join(dir, 'base.json'), JSON.stringify(base));
  await writeFile(
    join(dir, 'ami.json'),
    JSON.stringify({
      region: 'us-east-2',
      image_version: '0.2.2',
      git_commit: '25155ea',
      ami: {
        frontend: 'ami-0aec9c2e6b03643a3',
        backend: 'ami-0cba7c5e8e82efb49',
        db: 'ami-00c53587be2090056',
      },
    }),
  );
  server = createServer((_request, response) => {
    response.statusCode = healthStatus;
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.FAKE_HEALTH_BASE = `http://127.0.0.1:${server.address().port}`;
  config = {
    ...readConfig({ DATABASE_URL: 'postgresql://unused' }),
    IAC_STATE_BUCKET: 'state-bucket',
    IAC_BASE_OUTPUTS: join(dir, 'base.json'),
    IAC_AMI_IDS: join(dir, 'ami.json'),
    IAC_RUNS_DIR: join(dir, 'runs'),
    TERRAFORM_BIN: fixture('fake-terraform.mjs'),
    PYTHON_BIN: 'no-existe-python',
  };
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function withEnv(values, fn) {
  return async () => {
    const previous = {};
    for (const [key, value] of Object.entries(values)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  };
}

function context(input, events = []) {
  return {
    input,
    events,
    logRef: 'operations/test',
    report: async (message, options = {}) => {
      events.push({ message, ...options });
    },
  };
}

async function calls(log) {
  return (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('buildTenantInput arma la entrada común con base, AMIs, plan y respaldo', async () => {
  const input = await buildTenantInput(config, tenant, plan, { suspended: false });
  assert.equal(input.tenant_id, 'demo-p2');
  assert.deepEqual(input.sizing, plan.sizing);
  assert.deepEqual(input.backup, BACKUP_BY_PLAN.standard);
  assert.equal(input.ami.db, 'ami-00c53587be2090056');
  assert.equal(input.base.vpc_id, 'vpc-1');
  assert.equal(input.image.version, '0.2.2');
  assert.equal(input.suspended, false);
});

test('buildTenantInput rechaza una región distinta a la de la base', async () => {
  await assert.rejects(
    buildTenantInput(config, { ...tenant, region: 'us-east-1' }, plan, { suspended: false }),
    (error) => error instanceof OperationError && /us-east-2/.test(error.message),
  );
});

test('buildTenantInput explica si faltan los outputs de la base', async () => {
  await assert.rejects(
    buildTenantInput({ ...config, IAC_BASE_OUTPUTS: join(dir, 'no.json') }, tenant, plan, {
      suspended: false,
    }),
    (error) => error instanceof OperationError && /outputs de la base/.test(error.message),
  );
});

test('explainEngineError traduce errores conocidos y redacta el resto', () => {
  assert.match(
    explainEngineError(['│ Error: creating EC2 Instance: VcpuLimitExceeded']),
    /cuota de vCPU/,
  );
  assert.match(explainEngineError(['│ Error: Error acquiring the state lock']), /bloqueado/);
  const generic = explainEngineError(['│ Error: Invalid value password=hunter2secret'], 'Terraform');
  assert.match(generic, /^Terraform: Invalid value/);
  assert.doesNotMatch(generic, /hunter2secret/);
});

test('parsePlanLine y flattenOutputs', () => {
  assert.deepEqual(parsePlanLine('Plan: 9 to add, 1 to change, 2 to destroy.'), {
    add: 9,
    change: 1,
    destroy: 2,
  });
  assert.equal(parsePlanLine('otra línea'), null);
  assert.deepEqual(
    flattenOutputs({ a: { value: 1 }, b: { value: 'x', sensitive: true } }),
    { a: 1 },
  );
});

test(
  'Terraform apply: directorio por tenant, backend propio, resultado común y versiones',
  withEnv({ FAKE_TF_MODE: 'ok' }, async () => {
    const log = join(dir, 'apply.log');
    process.env.FAKE_TF_LOG = log;
    try {
      const input = await buildTenantInput(config, tenant, plan, { suspended: false });
      const ctx = context(input);
      const result = await getAdapter('terraform', config).apply(ctx);

      const runDir = join(config.IAC_RUNS_DIR, 'demo-p2', 'test');
      const backend = await readFile(join(runDir, 'backend.hcl'), 'utf8');
      assert.match(backend, /key\s+= "tenants\/demo-p2\/test\/terraform.tfstate"/);
      assert.match(backend, /bucket\s+= "state-bucket"/);
      assert.match(backend, /use_lockfile = true/);
      const vars = JSON.parse(await readFile(join(runDir, 'tenant.tfvars.json'), 'utf8'));
      assert.equal(vars.suspended, false);
      assert.equal(vars.engine, 'terraform');
      assert.deepEqual(vars.backup, { schedule: 'daily', retention_days: 14 });
      assert.match(vars.cloud_init_template_path, /infra\/cloud-init\/user-data\.yaml\.tftpl$/);
      await stat(join(runDir, 'module', 'compute.tf'));
      await stat(join(runDir, 'module', '.terraform.lock.hcl'));
      await assert.rejects(stat(join(runDir, 'current.tfplan')), { code: 'ENOENT' });

      const invocations = (await calls(log)).filter((call) => call.args);
      assert.deepEqual(
        invocations.map((call) => call.command),
        ['init', 'version', 'plan', 'apply', 'output'],
      );
      assert.ok(invocations.every((call) => call.chdir === join(runDir, 'module')));

      assert.equal(result.status, 'succeeded');
      assert.equal(result.log_ref, 'operations/test');
      assert.equal(result.outputs.instance_ids.db, 'i-33333333333333333');
      assert.equal(result.outputs.secret_thing, undefined);
      assert.deepEqual(
        result.resources.map((resource) => `${resource.type}:${resource.role}`),
        ['aws_instance:frontend', 'aws_instance:backend', 'aws_instance:db', 'aws_ebs_volume:db'],
      );
      assert.equal(result.tool_versions.terraform, '1.16.6');
      assert.equal(result.tool_versions.provider_aws, '6.20.0');
      assert.equal(result.tool_versions.image_version, '0.2.2');
      assert.match(result.tool_versions.templates_commit ?? '', /^[0-9a-f]{7,}/);
      assert.ok(ctx.events.some((event) => /Plan: crear 9, modificar 0, eliminar 0/.test(event.message)));
    } finally {
      delete process.env.FAKE_TF_LOG;
    }
  }),
);

test(
  'suspend aplica con suspended=true sobre el mismo estado',
  withEnv({ FAKE_TF_MODE: 'ok' }, async () => {
    const input = await buildTenantInput(config, tenant, plan, { suspended: false });
    await getAdapter('terraform', config).suspend(context(input));
    const vars = JSON.parse(
      await readFile(join(config.IAC_RUNS_DIR, 'demo-p2', 'test', 'tenant.tfvars.json'), 'utf8'),
    );
    assert.equal(vars.suspended, true);
  }),
);

test(
  'sin cambios no ejecuta apply (reintento idempotente)',
  withEnv({ FAKE_TF_MODE: 'nochange' }, async () => {
    const log = join(dir, 'nochange.log');
    process.env.FAKE_TF_LOG = log;
    try {
      const input = await buildTenantInput(config, tenant, plan, { suspended: false });
      const ctx = context(input);
      await getAdapter('terraform', config).apply(ctx);
      assert.ok(!(await calls(log)).some((call) => call.command === 'apply'));
      assert.ok(ctx.events.some((event) => /Sin cambios/.test(event.message)));
    } finally {
      delete process.env.FAKE_TF_LOG;
    }
  }),
);

test(
  'un plan fallido devuelve un mensaje comprensible',
  withEnv({ FAKE_TF_MODE: 'planfail' }, async () => {
    const input = await buildTenantInput(config, tenant, plan, { suspended: false });
    await assert.rejects(
      getAdapter('terraform', config).apply(context(input)),
      (error) => error instanceof OperationError && /cuota de vCPU/.test(error.message),
    );
  }),
);

test('sin IAC_STATE_BUCKET no ejecuta el motor', async () => {
  const input = await buildTenantInput(config, tenant, plan, { suspended: false });
  await assert.rejects(
    getAdapter('terraform', { ...config, IAC_STATE_BUCKET: '' }).apply(context(input)),
    (error) => error instanceof OperationError && /IAC_STATE_BUCKET/.test(error.message),
  );
});

test(
  'cancelar desde la UI durante apply espera a que termine el paso',
  withEnv({ FAKE_TF_MODE: 'slowapply' }, async () => {
    const log = join(dir, 'cancel.log');
    process.env.FAKE_TF_LOG = log;
    const input = await buildTenantInput(config, tenant, plan, { suspended: false });
    const controller = new AbortController();
    const seen = [];
    const ctx = {
      ...context(input),
      signal: controller.signal,
      report: async (message) => {
        seen.push(message);
        // Como el heartbeat de P6: la cancelación llega por la señal y por report.
        if (/Creating\.\.\./.test(message)) {
          controller.abort(new OperationCancelled());
          throw new OperationCancelled();
        }
      },
    };
    try {
      await assert.rejects(getAdapter('terraform', config).apply(ctx), OperationCancelled);
    } finally {
      delete process.env.FAKE_TF_LOG;
    }
    assert.ok(seen.some((line) => /aws_instance.db: Creating/.test(line)));
    // El apply terminó (no se mató a mitad) y no se leyeron outputs después de cancelar.
    const commands = (await calls(log)).map((call) => call.command);
    assert.ok(commands.includes('apply-finished'));
    assert.ok(!commands.includes('output'));
  }),
);

test(
  'perder la operación durante apply sí detiene el proceso',
  withEnv({ FAKE_TF_MODE: 'slowapply' }, async () => {
    const log = join(dir, 'lease.log');
    process.env.FAKE_TF_LOG = log;
    const input = await buildTenantInput(config, tenant, plan, { suspended: false });
    const controller = new AbortController();
    const ctx = {
      ...context(input),
      signal: controller.signal,
      report: async (message) => {
        if (/Creating\.\.\./.test(message)) controller.abort(new LeaseLost());
      },
    };
    try {
      await assert.rejects(getAdapter('terraform', config).apply(ctx), {
        code: 'COMMAND_CANCELLED',
      });
    } finally {
      delete process.env.FAKE_TF_LOG;
    }
    const commands = (await calls(log)).map((call) => call.command);
    assert.ok(!commands.includes('apply-finished'));
  }),
);

test('los cuatro motores tienen adaptadores reales registrados', () => {
  assert.equal(engineAvailable('terraform'), true);
  assert.equal(engineAvailable('tofu'), true);
  assert.equal(engineAvailable('cloudformation'), true);
  assert.equal(engineAvailable('pulumi'), true);
  assert.equal(getAdapter('pulumi', config).engine, 'pulumi');
  assert.equal(getAdapter('cloudformation', config).engine, 'cloudformation');
});

test('assertCanEnqueue valida motor, estado y confirmación de eliminación', () => {
  assert.doesNotThrow(() => assertCanEnqueue(tenant, 'create'));
  assert.doesNotThrow(() => assertCanEnqueue(tenant, 'diagnostic'));
  assert.doesNotThrow(() => assertCanEnqueue({ ...tenant, engine: 'pulumi' }, 'create'));
  assert.throws(() => assertCanEnqueue({ ...tenant, engine: 'unknown' }, 'create'), {
    code: 'ENGINE_NOT_AVAILABLE',
  });
  assert.throws(() => assertCanEnqueue(tenant, 'suspend'), { code: 'INVALID_TENANT_STATE' });
  assert.throws(() => assertCanEnqueue({ ...tenant, status: 'ready' }, 'destroy', { confirm: 'otro' }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  assert.doesNotThrow(() =>
    assertCanEnqueue({ ...tenant, status: 'ready' }, 'destroy', { confirm: 'demo-p2' }),
  );
});

test('waitForHealth espera 200 y explica el timeout', async () => {
  const urls = { frontend: `${process.env.FAKE_HEALTH_BASE}/healthz` };
  healthStatus = 200;
  assert.deepEqual(await waitForHealth(urls, { timeoutMs: 2000, intervalMs: 50 }), {
    frontend: 200,
  });
  healthStatus = 503;
  await assert.rejects(
    waitForHealth(urls, { timeoutMs: 300, intervalMs: 50 }),
    (error) => error instanceof OperationError && /frontend no respondió/.test(error.message),
  );
  healthStatus = 200;
});
