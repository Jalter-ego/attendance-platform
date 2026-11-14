#!/usr/bin/env node
// CLI de Pulumi simulado para las pruebas del adaptador (P2). Guarda los stacks en
// .fake-pulumi.json dentro del directorio de ejecución y registra cada llamada en
// .fake-pulumi-calls.log. No habla con AWS.
//   FAKE_PULUMI_REPLACE_VOLUME=1 → el preview reemplaza el disco de datos.
//   FAKE_PULUMI_FAIL=vcpu        → `up` falla por cuota de vCPU.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((arg) => !['--non-interactive', '--color', 'never'].includes(arg));
const file = '.fake-pulumi.json';
const db = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { current: null, stacks: {} };
const save = () => writeFileSync(file, JSON.stringify(db, null, 2));
appendFileSync('.fake-pulumi-calls.log', `${args.join(' ')} | passphrase=${process.env.PULUMI_CONFIG_PASSPHRASE ? 'set' : 'unset'}\n`);
const fail = (message) => { process.stderr.write(`error: ${message}\n`); process.exit(255); };
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const stackOf = () => {
  const name = flag('--stack') ?? db.current;
  if (!db.stacks[name]) fail(`no stack named '${name}' found`);
  return db.stacks[name];
};
const ROLES = ['frontend', 'backend', 'db'];
const urn = (stack, type, name) => `urn:pulumi:${stack.split('/').at(-1)}::attendance-tenant::${type}::${name}`;
function desired(stackName, input) {
  return [
    ['pulumi:pulumi:Stack', `attendance-tenant-${stackName.split('/').at(-1)}`],
    ['pulumi:providers:aws', 'tenant'],
    ['aws:ebs/volume:Volume', 'db-data'],
    ...ROLES.map((role) => ['aws:ec2/instance:Instance', role]),
    ...ROLES.map((role) => [`aws:ec2transitgateway/instanceState:InstanceState`, `state-${role}`]),
  ].map(([type, name]) => ({
    urn: urn(stackName, type, name), type, name,
    attrs: name.startsWith('state-') ? { state: input.suspended ? 'stopped' : 'running' } : name === 'db-data' ? { size: input.sizing.db_disk_gb } : {},
  }));
}
function plan(stackName, stack) {
  const input = JSON.parse(stack.config['attendance-tenant:input']);
  const current = new Map(stack.resources.map((resource) => [resource.urn, resource]));
  return desired(stackName, input).map((resource) => {
    const before = current.get(resource.urn);
    let op = !before ? 'create' : JSON.stringify(before.attrs) === JSON.stringify(resource.attrs) ? 'same' : 'update';
    if (resource.type === 'aws:ebs/volume:Volume' && before && process.env.FAKE_PULUMI_REPLACE_VOLUME === '1') op = 'replace';
    return { ...resource, op };
  });
}

const [command, sub] = args;
if (command === 'version') {
  console.log('v3.999.0');
} else if (command === 'stack' && sub === 'select') {
  const name = args[2];
  if (!db.stacks[name]) {
    if (!args.includes('--create')) fail(`no stack named '${name}' found`);
    db.stacks[name] = { config: {}, resources: [], protected: true, secrets: flag('--secrets-provider') };
    console.error(`Created stack '${name}'`);
  }
  db.current = name;
  save();
} else if (command === 'config' && sub === 'set') {
  const stack = stackOf();
  stack.config[args[2]] = readFileSync(0, 'utf8');
  save();
} else if (command === 'preview') {
  const name = flag('--stack');
  const steps = plan(name, stackOf()).map(({ urn: id, op, type }) => ({ op, urn: id, newState: { type } }));
  console.log(JSON.stringify({ steps, changeSummary: {} }));
} else if (command === 'up') {
  const name = flag('--stack');
  const stack = stackOf();
  const steps = plan(name, stack);
  if (process.env.FAKE_PULUMI_FAIL === 'vcpu') {
    console.log('aws:ec2/instance:Instance (db) creating');
    fail('creating EC2 Instance: VcpuLimitExceeded: You have requested more vCPU capacity than your current vCPU limit');
  }
  for (const step of steps) if (step.op !== 'same') console.log(`${step.type} (${step.name}) ${step.op}d`);
  stack.resources = steps.map(({ urn: id, type, name: resourceName, attrs }, index) => ({
    urn: id, type, name: resourceName, attrs,
    id: type === 'aws:ec2/instance:Instance' ? `i-0${String(index).padStart(16, '0')}` : type === 'aws:ebs/volume:Volume' ? 'vol-0123456789abcdef0' : `${resourceName}-id`,
  }));
  stack.suspended = JSON.parse(stack.config['attendance-tenant:input']).suspended;
  stack.ip = stack.suspended ? null : `3.15.0.${10 + (stack.starts = (stack.starts ?? 0) + 1)}`;
  save();
  console.log('Resources: done');
} else if (command === 'stack' && sub === 'output') {
  const stack = stackOf();
  const ids = Object.fromEntries(stack.resources.filter(({ type }) => type === 'aws:ec2/instance:Instance').map(({ name, id }) => [name, id]));
  const root = stack.ip ? `http://${stack.ip}` : null;
  console.log(JSON.stringify({
    deployment_name: 'attendance-p-demo-pulumi-test-1234abcd',
    urls: { frontend: root && `${root}/`, api: root && `${root}/core/api/v1`, frontend_health: root && `${root}/healthz`, backend_health: root && `${root}/core/api/v1/health` },
    suspended: stack.suspended, instance_ids: ids,
    private_ips: { frontend: '10.0.1.10', backend: '10.0.2.10', db: '10.0.2.11' },
    db_volume_id: 'vol-0123456789abcdef0', ssm_prefix: '/tenants/demo-pulumi/test',
  }));
} else if (command === 'stack' && sub === 'export') {
  const stack = stackOf();
  console.log(JSON.stringify({ version: 3, deployment: { resources: stack.resources.map(({ urn: id, id: physical }) => ({ urn: id, id: physical })) } }));
} else if (command === 'state' && sub === 'unprotect') {
  stackOf().protected = false;
  save();
} else if (command === 'destroy') {
  const stack = stackOf();
  if (stack.protected) fail("unable to delete resource 'db-data' as it is currently marked for protection. To unprotect the resource, run `pulumi state unprotect`");
  for (const resource of stack.resources) console.log(`${resource.type} (${resource.name}) deleted`);
  stack.resources = [];
  save();
} else {
  fail(`comando simulado no soportado: ${args.join(' ')}`);
}
