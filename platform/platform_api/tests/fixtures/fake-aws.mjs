// Simula `aws ssm put-parameter --cli-input-json file://...` para las pruebas de secretos.
// FAKE_AWS_EXISTING: nombres cortos que ya existen (p. ej. "db_password").
// FAKE_AWS_LOG: guarda nombre y longitud del valor (nunca el valor) por llamada.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args[args.indexOf('--cli-input-json') + 1].replace(/^file:\/\//, '');
const request = JSON.parse(readFileSync(input, 'utf8'));
const short = request.Name.split('/').pop();
if (process.env.FAKE_AWS_LOG)
  appendFileSync(
    process.env.FAKE_AWS_LOG,
    `${JSON.stringify({ name: request.Name, type: request.Type, length: request.Value.length, alnum: /^[A-Za-z0-9]+$/.test(request.Value), overwrite: request.Overwrite })}\n`,
  );
if (process.env.FAKE_AWS_MODE === 'denied') {
  console.error('An error occurred (AccessDeniedException) when calling the PutParameter operation: not authorized');
  process.exit(254);
}
if ((process.env.FAKE_AWS_EXISTING ?? '').split(',').includes(short)) {
  console.error('An error occurred (ParameterAlreadyExists) when calling the PutParameter operation');
  process.exit(254);
}
console.log(JSON.stringify({ Version: 1, Tier: 'Standard' }));
