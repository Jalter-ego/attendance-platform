import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureTenantSecrets } from '../src/worker/services/tenant-secrets.js';
import { OperationCancelled } from '../src/worker/errors.js';

const tenant = { tenant_id: 'demo', env: 'test', region: 'us-east-2' };
function store({ onPut = () => {} } = {}) {
  const parameters = new Map();
  const requests = [];
  return {
    parameters, requests,
    async send(command, options) {
      assert.ok(options.abortSignal);
      const { input } = command;
      requests.push(command);
      if (command.constructor.name === 'DescribeParametersCommand') {
        const filter = input.ParameterFilters[0];
        assert.deepEqual([filter.Key, filter.Option], ['Name', 'Equals']);
        const Name = filter.Values[0];
        const parameter = parameters.get(Name);
        return { Parameters: parameter ? [{ Name, Type: parameter.Type }] : [] };
      }
      assert.equal(command.constructor.name, 'PutParameterCommand');
      await onPut(input, parameters);
      if (parameters.has(input.Name)) throw Object.assign(new Error(), { name: 'ParameterAlreadyExists' });
      parameters.set(input.Name, input);
      return { Version: 1 };
    },
  };
}

test('crea tres SecureString sin exponer valores y el reintento los conserva', async () => {
  const client = store();
  const first = await ensureTenantSecrets(tenant, { client });
  const values = [...client.parameters.values()].map((parameter) => parameter.Value);
  assert.equal(first.created.length, 3);
  assert.equal(first.reused.length, 0);
  assert.equal(new Set(values).size, 3);
  for (const parameter of client.parameters.values()) {
    assert.match(parameter.Name, /^\/tenants\/demo\/test\/(db_password|jwt_secret|admin_password)$/);
    assert.match(parameter.Value, /^[a-f0-9]{64}$/);
    assert.equal(parameter.Type, 'SecureString');
    assert.equal(parameter.Overwrite, false);
    assert.equal(parameter.KeyId, 'alias/aws/ssm');
    assert.equal(parameter.Tier, 'Standard');
    assert.deepEqual(parameter.Tags, [{ Key: 'Project', Value: 'attendance-platform' }, { Key: 'Tenant', Value: 'demo' }, { Key: 'Env', Value: 'test' }]);
    assert.ok(!JSON.stringify(first).includes(parameter.Value));
  }
  const second = await ensureTenantSecrets(tenant, { client });
  assert.equal(second.created.length, 0);
  assert.equal(second.reused.length, 3);
  assert.deepEqual([...client.parameters.values()].map((p) => p.Value), values);
  assert.equal(client.requests.filter((command) => command.constructor.name === 'PutParameterCommand').length, 3);
});

test('un fallo parcial permite continuar sin regenerar la contraseña ya creada', async () => {
  let fail = true;
  const client = store({ onPut: (input) => {
    if (fail && input.Name.endsWith('/jwt_secret')) throw new Error('dato privado del proveedor');
  } });
  await assert.rejects(ensureTenantSecrets(tenant, { client }), (error) => error.code === 'SSM_PREPARE_FAILED' && !error.message.includes('dato privado'));
  const original = client.parameters.get('/tenants/demo/test/db_password').Value;
  fail = false;
  const result = await ensureTenantSecrets(tenant, { client });
  assert.equal(client.parameters.get('/tenants/demo/test/db_password').Value, original);
  assert.equal(result.created.length, 2);
  assert.deepEqual(result.reused, ['/tenants/demo/test/db_password']);
});

test('no convierte ni sobrescribe un parámetro existente de tipo String', async () => {
  const client = store();
  client.parameters.set('/tenants/demo/test/db_password', { Type: 'String', Value: 'existente' });
  await assert.rejects(ensureTenantSecrets(tenant, { client }), (error) => error.code === 'SSM_INSECURE_PARAMETER');
  assert.equal(client.parameters.get('/tenants/demo/test/db_password').Value, 'existente');
  assert.equal(client.requests.length, 1);
});

test('si otro intento crea el secreto a la vez, reutiliza su valor sin sobrescribir', async () => {
  const client = store({ onPut: (input, parameters) => {
    if (input.Name.endsWith('/db_password')) parameters.set(input.Name, { Type: 'SecureString', Value: 'otro-intento' });
  } });
  const result = await ensureTenantSecrets(tenant, { client });
  assert.equal(client.parameters.get('/tenants/demo/test/db_password').Value, 'otro-intento');
  assert.deepEqual(result.reused, ['/tenants/demo/test/db_password']);
});

test('otro tenant/entorno usa nombres distintos y no consulta valores de secretos', async () => {
  const client = store();
  await ensureTenantSecrets(tenant, { client });
  const result = await ensureTenantSecrets({ ...tenant, tenant_id: 'otro-cliente', env: 'prod' }, { client });
  assert.equal(result.ssm_prefix, '/tenants/otro-cliente/prod');
  assert.equal(client.parameters.size, 6);
  assert.ok(client.requests.every((command) => ['DescribeParametersCommand', 'PutParameterCommand'].includes(command.constructor.name)));
});

test('rechaza identidades inválidas y cancelaciones antes de hablar con SSM', async () => {
  const client = store();
  await assert.rejects(ensureTenantSecrets({ ...tenant, tenant_id: '../otro' }, { client }), (error) => error.code === 'SSM_CONFIG');
  await assert.rejects(ensureTenantSecrets(tenant, { client, signal: AbortSignal.abort() }), OperationCancelled);
  assert.equal(client.requests.length, 0);
});

test('traduce un error IAM sin copiar detalles privados del SDK', async () => {
  const client = { send: async () => { throw Object.assign(new Error('credencial privada'), { name: 'AccessDeniedException' }); } };
  await assert.rejects(ensureTenantSecrets(tenant, { client }), (error) => error.code === 'SSM_ACCESS_DENIED' && !error.message.includes('credencial privada'));
});

test('la cancelación y el deadline abortan una petición de SSM en curso', async () => {
  const client = { send: (_command, { abortSignal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('no debe alcanzar este plazo')), 1000);
    abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('AbortError')); }, { once: true });
  }) };
  const controller = new AbortController();
  const running = ensureTenantSecrets(tenant, { client, signal: controller.signal });
  controller.abort();
  await assert.rejects(running, OperationCancelled);
  await assert.rejects(ensureTenantSecrets(tenant, { client, timeoutMs: 25 }), (error) => error.code === 'SSM_TIMEOUT');
});

test('recorre la paginación de metadatos antes de decidir si falta un secreto', async () => {
  const client = store();
  await ensureTenantSecrets(tenant, { client });
  const send = client.send.bind(client);
  let pages = 0;
  client.send = async (command, options) => {
    if (command.constructor.name === 'DescribeParametersCommand' && !command.input.NextToken) {
      pages++;
      return { Parameters: [], NextToken: 'segunda-pagina' };
    }
    return send(command, options);
  };
  const result = await ensureTenantSecrets(tenant, { client });
  assert.equal(pages, 3);
  assert.equal(result.created.length, 0);
  assert.equal(result.reused.length, 3);
});
