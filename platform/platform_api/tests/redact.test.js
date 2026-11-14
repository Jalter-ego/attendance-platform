import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact, createLogRedactor } from '../src/lib/redact.js';

test('oculta contraseñas completas con espacios, tokens, URI y credenciales AWS', () => {
  const samples = [
    'password="una clave con espacios"', "secret='una clave con espacios'",
    '{"access_token":"una clave con espacios"}', 'Authorization: Bearer valor_privado',
    'postgresql://user:valor_privado@host/db?sslmode=require',
    'AWS_ACCESS_KEY_ID=AKIA1234567890123456',
    'https://s3/bucket?X-Amz-Signature=valor_privado&X-Amz-Security-Token=valor_privado',
    '\x1b[31mpassword\x1b[0m=valor_privado',
  ];
  for (const sample of samples) {
    const safe = redact(sample);
    assert.ok(!safe.includes('valor_privado') && !safe.includes('clave con espacios') && !safe.includes('AKIA1234567890123456'), safe);
  }
});

test('redacta los secretos conocidos aun sin nombre de campo y en JSON/URL', () => {
  const secret = 'una "clave"/privada';
  for (const text of [secret, JSON.stringify(secret), encodeURIComponent(secret)])
    assert.ok(!redact(text, [secret]).includes('privada'));
});

test('no entrega el cuerpo de una clave privada entre varias líneas', () => {
  const mask = createLogRedactor();
  const lines = ['-----BEGIN RSA PRIVATE KEY-----', 'cuerpoPrivadoBase64', '-----END RSA PRIVATE KEY-----', 'listo'];
  assert.deepEqual(lines.map((line) => mask(line, 'stderr')), ['[REDACTED PRIVATE KEY]', '[REDACTED PRIVATE KEY]', '[REDACTED PRIVATE KEY]', 'listo']);
  assert.equal(mask('stdout normal', 'stdout'), 'stdout normal');
});
