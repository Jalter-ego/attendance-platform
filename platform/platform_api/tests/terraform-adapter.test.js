import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runTerraformOperation } from '../src/worker/services/terraform-adapter.js';

const tenant = {
  id: 'b5b18331-ca7e-4ac6-ae72-172958ef3721',
  tenant_id: 'colegio-a', env: 'test', engine: 'terraform', region: 'us-east-2',
  status: 'draft', name: 'Colegio A', contact_email: 'admin@example.com', timezone: 'America/La_Paz',
};
const basic = {
  code: 'basic',
  sizing: { frontend: 't3.micro', backend: 't3.micro', db: 't3.micro', db_disk_gb: 10 },
  limits: { max_students: 100 },
};
const standard = { ...basic, code: 'standard', sizing: { ...basic.sizing, db_disk_gb: 50 } };
const images = {
  region: tenant.region, image_version: '0.2.2',
  ami: { frontend: 'ami-11111111111111111', backend: 'ami-22222222222222222', db: 'ami-33333333333333333' },
};
const instances = { frontend: 'i-11111111', backend: 'i-22222222', db: 'i-33333333' };
const base = {
  project_name: 'attendance-platform', region: tenant.region, availability_zone: 'us-east-2a',
  vpc_id: 'vpc-ab01', public_subnet_id: 'subnet-ab01', private_subnet_id: 'subnet-ab02',
  monitoring_security_group_id: 'sg-ab01', ssm_endpoint_id: 'vpce-ab01', backups_bucket: 'tenant-backups-test',
};
const oneChange = {
  mode: 'managed', address: 'aws_ebs_volume.db', type: 'aws_ebs_volume',
  change: { actions: ['create'], before: null, after: { size: 10, opaque: 'output-que-no-debe-aparecer' } },
};

async function setup(t) {
  const parent = resolve(tmpdir());
  const repoRoot = await mkdtemp(join(parent, 'attendance-adapter-'));
  t.after(async () => {
    assert.ok(resolve(repoRoot).startsWith(join(parent, 'attendance-adapter-')));
    await rm(repoRoot, { recursive: true, force: true });
  });
  const terraform = join(repoRoot, 'infra', 'terraform', 'tenant');
  const cloudInit = join(repoRoot, 'infra', 'cloud-init');
  const packer = join(repoRoot, 'infra', 'packer');
  await Promise.all([terraform, cloudInit, packer].map((directory) => mkdir(directory, { recursive: true })));
  const amiFile = join(packer, 'ami-ids.json');
  await Promise.all([
    writeFile(join(terraform, 'backend.tf'), 'terraform { backend "s3" {} }'),
    writeFile(join(cloudInit, 'user-data.yaml.tftpl'), '#cloud-config\n'),
    writeFile(amiFile, JSON.stringify(images)),
    writeFile(join(repoRoot, 'base.json'), JSON.stringify(base)),
  ]);
  const config = {
    PLATFORM_DEPLOY_MODE: 'integration', PLATFORM_STATE_BUCKET: 'tenant-states-test',
    PLATFORM_BASE_OUTPUT_FILE: 'base.json', BACKUP_BASH: 'test-bash',
  };
  const calls = [];
  const reports = [];
  let runner = { changes: [oneChange], healthy: true, ip: '203.0.113.1' };
  const stdout = (value) => ({ exitCode: 0, stdout: JSON.stringify(value) });
  async function run(args) {
    const [action] = args.args;
    const call = { action, args, options: args.args };
    calls.push(call);
    if (args.command === 'test-bash') {
      if (action.endsWith('tenant-update.sh')) {
        const component = args.args[args.args.indexOf('--component') + 1];
        const version = args.args[args.args.indexOf('--version') + 1];
        return stdout({ tenant: tenant.tenant_id, env: tenant.env, status: 'succeeded', component, to: version,
          instance_id: instances[component] });
      }
      assert.ok(action.endsWith('tenant-health.sh'));
      assert.ok(args.args.includes('--boot'));
      assert.equal(args.logStdout, false);
      if (!runner.healthy) return { exitCode: 1, stdout: '{"status":"unhealthy"}' };
      return stdout({ tenant: tenant.tenant_id, env: tenant.env, status: 'healthy',
        checks: { frontend: { status: 200 }, backend: { status: 200 } },
        boot: ['frontend', 'backend'].map((role) => ({ role, instance_id: instances[role],
          boot: { tenant_id: tenant.tenant_id, env: tenant.env, status: 'ready', app_version: 'a'.repeat(40) } })) });
    }
    if (args.command === 'aws') {
      assert.deepEqual(args.args.slice(0, 2), ['ec2', 'describe-instances']);
      return stdout(runner.targets ?? [instances.backend]);
    }
    assert.ok(['terraform', 'tofu'].includes(args.command));
    switch (action) {
      case 'init':
        assert.equal(args.env.TF_WORKSPACE, 'default');
        call.backend = await readFile(join(args.cwd, 'tenant.backend.hcl'), 'utf8');
        // A readonly init leaves the already pinned lock file unchanged.
        await writeFile(join(args.cwd, '.terraform.lock.hcl'), 'fake lock');
        return { exitCode: 0 };
      case 'version':
        return stdout({ terraform_version: '1.16.6', provider_selections: { 'registry.terraform.io/hashicorp/aws': '6.69.1' } });
      case 'plan':
        call.vars = JSON.parse(await readFile(join(args.cwd, 'tenant.tfvars.json'), 'utf8'));
        assert.equal(args.acceptedExitCodes.includes(2), true);
        assert.ok(args.args.includes('-lock-timeout=5m'));
        await args.onLine('private = "output-que-no-debe-aparecer"', 'stderr');
        await args.onLine('Plan: 1 to add, 0 to change, 0 to destroy.', 'stdout');
        return { exitCode: runner.changes.length ? 2 : 0 };
      case 'show':
        return stdout({ format_version: '1.2', complete: true, applyable: runner.changes.length > 0,
          resource_changes: runner.changes });
      case 'apply':
        assert.ok(args.args.includes('review.tfplan'));
        return { exitCode: 0 };
      case 'output': {
        const vars = JSON.parse(await readFile(join(args.cwd, 'tenant.tfvars.json'), 'utf8'));
        const url = `http://${runner.ip}`;
        const values = {
          urls: vars.suspended ? {} : {
            frontend: `${url}/`, api: `${url}/core/api/v1`, frontend_health: `${url}/healthz`, backend_health: `${url}/core/api/v1/health`,
          },
          instance_ids: instances, private_ips: { frontend: '10.0.0.1', backend: '10.0.0.2', db: '10.0.0.3' },
          db_volume_id: 'vol-ab01', suspended: vars.suspended,
        };
        return stdout({ ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, sensitive: false }])),
          password: { value: 'output-que-no-debe-aparecer', sensitive: true },
        });
      }
      default: throw new Error(`unexpected command: ${action}`);
    }
  }
  const prepareSecrets = async (_, options) => {
    assert.equal(options.projectName, base.project_name);
    calls.push({ action: 'ssm' });
  };
  const perform = (type, overrides = {}) => runTerraformOperation({
    config, tenant, plan: basic, operation: { type, params: {} },
    report: async (message) => { reports.push(message); }, ...overrides,
  }, { repoRoot, run, prepareSecrets });
  return { repoRoot, amiFile, calls, reports, config, perform, configure: (newValues) => { runner = { ...runner, ...newValues }; } };
}

test('create preps SSM, retries the same state and pinned AMIs, hides private CLI values', async (t) => {
  const fixture = await setup(t);
  fixture.configure({ healthy: false });
  await assert.rejects(fixture.perform('create'), { code: 'IAC_UNHEALTHY' });
  await writeFile(fixture.amiFile, JSON.stringify({ ...images, image_version: '0.2.3',
    ami: { ...images.ami, frontend: 'ami-44444444444444444' } }));
  fixture.configure({ healthy: true, changes: [] });
  const result = await fixture.perform('create');
  assert.equal(result.tenantStatus, 'ready');
  assert.deepEqual(result.deployment.ami, images.ami);
  assert.equal(result.deployment.outputs.urls.frontend, 'http://203.0.113.1/');
  assert.equal(result.deployment.outputs.health.database, 'healthy');
  assert.equal(result.deployment.tool_versions.infrastructure, '0.2.2');
  assert.equal(result.deployment.tool_versions.app.frontend, 'a'.repeat(40));
  assert.equal(result.deployment.tool_versions.app.backend, 'a'.repeat(40));
  assert.equal(result.deployment.tool_versions.terraform, '1.16.6');
  assert.deepEqual(fixture.calls.filter(({ action }) => action === 'init').map(({ backend }) => backend.includes('key = "tenants/colegio-a/test/terraform.tfstate"')), [true, true]);
  assert.equal(fixture.calls.findIndex(({ action }) => action === 'ssm') < fixture.calls.findIndex(({ action }) => action === 'apply'), true);
  assert.equal(fixture.calls.filter(({ action }) => action === 'apply').length, 1);
  assert.equal(fixture.reports.some((line) => line.includes('output-que-no-debe-aparecer')), false);
  assert.equal(JSON.stringify(result).includes('output-que-no-debe-aparecer'), false);
  const stored = await readdir(join(fixture.repoRoot, '.local', 'platform-iac', 'test', 'tenant-colegio-a'));
  assert.deepEqual(stored.sort(), ['.terraform.lock.hcl', 'initial-image.json', 'state-binding.json']);
  await assert.rejects(fixture.perform('create', { config: { ...fixture.config, PLATFORM_STATE_BUCKET: 'new-state-bucket' } }), { code: 'IAC_STATE_CHANGED' });
});

test('plan-change rejects drift and delete requires the matching real plan', async (t) => {
  const fixture = await setup(t);
  const initial = await fixture.perform('create');
  const changed = { ...oneChange, change: { actions: ['update'], before: { size: 10 }, after: { size: 50 } } };
  fixture.configure({ changes: [changed] });
  const options = { plan: standard, tenant: { ...tenant, status: 'ready' }, deployment: initial.deployment };
  const { result: preview } = await fixture.perform('preview-plan', options);
  assert.match(preview.changes[0], /Modificar.+disco de datos/);
  assert.match(preview.plan_digest, /^[0-9a-f]{64}$/);
  fixture.configure({ changes: [{ ...changed, change: { ...changed.change, before: { size: 11 } } }] });
  await assert.rejects(fixture.perform('plan-change', { ...options, preview }), { code: 'IAC_PREVIEW_CHANGED' });
  fixture.configure({ changes: [changed] });
  const planChange = await fixture.perform('plan-change', { ...options, preview });
  assert.equal(planChange.deployment.outputs.sizing.db_disk_gb, 50);
  fixture.configure({ changes: [{ ...oneChange, change: { actions: ['delete'], before: { size: 50 }, after: null } }] });
  const deleteOptions = { ...options, deployment: planChange.deployment };
  const { result: deletePreview } = await fixture.perform('preview-delete', deleteOptions);
  assert.match(deletePreview.changes[0], /Eliminar.+disco de datos/);
  await assert.rejects(fixture.perform('delete', deleteOptions), { code: 'IAC_PREVIEW_CHANGED' });
  const deleted = await fixture.perform('delete', { ...deleteOptions, preview: deletePreview });
  assert.equal(deleted.tenantStatus, 'deleted');
  assert.deepEqual(deleted.deployment.outputs.urls, {});
  assert.ok(fixture.calls.filter(({ action }) => action === 'plan').at(-1).options.includes('-destroy'));
});

test('uses resource limits and the backup policy from a custom P4 plan snapshot', async (t) => {
  const fixture = await setup(t);
  const plan = {
    ...basic,
    code: 'high-school',
    name: 'Secundaria',
    version: 2,
    limits: { max_courses: 35 },
    backup: { schedule: 'daily', retention_days: 30 },
  };
  await fixture.perform('create', { plan });
  const { vars } = fixture.calls.find(({ action }) => action === 'plan');
  assert.equal(vars.plan, plan.code);
  assert.deepEqual(vars.limits, plan.limits);
  assert.deepEqual(vars.backup, plan.backup);
});

test('suspend preserves IDs, resume health-checks the replacement public URL, app upgrade targets the recorded instance', async (t) => {
  const fixture = await setup(t);
  const initial = await fixture.perform('create');
  fixture.configure({ changes: [{
    address: 'aws_ec2_instance_state.app["frontend"]', type: 'aws_ec2_instance_state', mode: 'managed',
    change: { actions: ['update'], before: { state: 'running' }, after: { state: 'stopped' } },
  }] });
  const suspended = await fixture.perform('suspend', { deployment: initial.deployment });
  assert.equal(suspended.tenantStatus, 'suspended');
  assert.equal(suspended.deployment.outputs.urls.frontend, null);
  assert.deepEqual(suspended.deployment.outputs.instance_ids, instances);
  fixture.configure({ ip: '203.0.113.2' });
  const resumed = await fixture.perform('resume', { deployment: suspended.deployment });
  assert.equal(resumed.deployment.outputs.urls.frontend, 'http://203.0.113.2/');
  const params = { scope: 'app', component: 'backend', version: '0123456789ab' };
  fixture.configure({ targets: ['i-11111111'] });
  await assert.rejects(fixture.perform('upgrade', { operation: { type: 'upgrade', params }, deployment: resumed.deployment }), { code: 'IAC_RELEASE_INVALID' });
  fixture.configure({ targets: [instances.backend] });
  const updated = await fixture.perform('upgrade', { operation: { type: 'upgrade', params }, deployment: resumed.deployment });
  assert.equal(updated.deployment.tool_versions.app.backend, params.version);
  assert.deepEqual(updated.deployment.outputs.instance_ids, instances);
  assert.match(fixture.calls.at(-1).action, /tenant-health\.sh$/);
});

test('rejects local mode and unsupported real engines before invoking any tool', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(fixture.perform('create', { config: { PLATFORM_DEPLOY_MODE: 'local' } }), { code: 'IAC_MODE' });
  await assert.rejects(fixture.perform('create', { tenant: { ...tenant, engine: 'pulumi' } }), { code: 'IAC_ENGINE_UNSUPPORTED' });
  assert.deepEqual(fixture.calls, []);
});
