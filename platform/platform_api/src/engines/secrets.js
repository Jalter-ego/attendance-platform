// Secretos del tenant en SSM Parameter Store (SecureString), requeridos por el arranque de
// P3 (infra/terraform/tenant/README.md, paso 4). Se generan FUERA del IaC: Terraform solo
// recibe el prefijo, así que los valores nunca llegan al tfstate, al repo ni a los eventos.
//
// Idempotente: si el parámetro ya existe no se reemplaza (reintentar no cambia contraseñas
// de una BD ya inicializada). Pendiente de acordar con P6 si esta pieza pasa a su módulo.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, runCli } from './cli.js';
import { OperationError } from '../lib/operation-error.js';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// El contrato de arranque actual pide valores alfanuméricos.
export const TENANT_SECRETS = [
  { name: 'db_password', length: 24 },
  { name: 'jwt_secret', length: 48 },
  { name: 'admin_password', length: 20 },
];

export function randomSecret(length) {
  let value = '';
  for (let i = 0; i < length; i += 1) value += ALPHABET[randomInt(ALPHABET.length)];
  return value;
}

export function ssmPrefix(tenant) {
  return `/tenants/${tenant.tenant_id}/${tenant.env}`;
}

/** Crea los parámetros que falten. Devuelve { created: [...], existing: [...] } (solo nombres). */
export async function ensureTenantSecrets(config, tenant, { signal } = {}) {
  const created = [];
  const existing = [];
  // El valor va en un archivo temporal privado, no en la línea de comandos (visible en ps).
  const directory = await mkdtemp(join(tmpdir(), 'tenant-secrets-'));
  try {
    for (const secret of TENANT_SECRETS) {
      const name = `${ssmPrefix(tenant)}/${secret.name}`;
      const file = join(directory, `${secret.name}.json`);
      await writeFile(
        file,
        JSON.stringify({
          Name: name,
          Value: randomSecret(secret.length),
          Type: 'SecureString',
          Overwrite: false,
        }),
        { mode: 0o600 },
      );
      const result = await runCli(
        config.AWS_BIN,
        [
          'ssm',
          'put-parameter',
          '--region',
          tenant.region,
          '--cli-input-json',
          `file://${file.replaceAll('\\', '/')}`,
          '--output',
          'json',
        ],
        {
          env: childEnv({ AWS_PAGER: '' }),
          capture: true,
          signal,
          timeoutMs: 60000,
          label: 'aws ssm put-parameter',
        },
      );
      await rm(file, { force: true });
      const stderr = result.stderrTail.join('\n');
      if (result.code === 0) created.push(secret.name);
      else if (/ParameterAlreadyExists/.test(stderr)) existing.push(secret.name);
      else
        throw new OperationError(
          /credential|ExpiredToken/i.test(stderr)
            ? 'El worker no tiene credenciales de AWS válidas para escribir en SSM.'
            : /AccessDenied|not authorized/i.test(stderr)
              ? `Las credenciales del worker no pueden escribir ${name} en SSM.`
              : `No se pudo crear el parámetro ${name} en SSM.`,
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { created, existing };
}
