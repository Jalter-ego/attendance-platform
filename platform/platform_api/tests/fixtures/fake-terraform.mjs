// Simula terraform/tofu para las pruebas de los adaptadores. El modo sale de FAKE_TF_MODE y
// cada invocación se agrega a FAKE_TF_LOG (una línea JSON por llamada).
import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const mode = process.env.FAKE_TF_MODE ?? 'ok';
const chdir = args.find((arg) => arg.startsWith('-chdir='))?.slice(7);
const command = args.find((arg) => !arg.startsWith('-'));
if (process.env.FAKE_TF_LOG)
  appendFileSync(process.env.FAKE_TF_LOG, `${JSON.stringify({ command, args, chdir,
    workspace: process.env.TF_WORKSPACE, extraPlanArgs: process.env.TF_CLI_ARGS_plan })}\n`);

const health = process.env.FAKE_HEALTH_BASE ?? 'http://127.0.0.1:9';
switch (command) {
  case 'init':
    console.log('Initializing the backend...');
    console.log('Terraform has been successfully initialized!');
    break;
  case 'version':
    console.log(
      JSON.stringify({
        terraform_version: '1.16.6',
        provider_selections: { 'registry.terraform.io/hashicorp/aws': '6.20.0' },
      }),
    );
    break;
  case 'plan': {
    if (mode === 'planfail') {
      console.error('╷');
      console.error('│ Error: creating EC2 Instance: VcpuLimitExceeded: You have requested more vCPU capacity');
      console.error('╵');
      process.exit(1);
    }
    if (mode === 'lock') {
      console.error('│ Error: Error acquiring the state lock');
      process.exit(1);
    }
    if (mode === 'generic') {
      console.error('│ Error: Invalid value for variable password=hunter2secret');
      process.exit(1);
    }
    const out = args.find((arg) => arg.startsWith('-out='))?.slice(5);
    if (out) writeFileSync(out, 'fake plan');
    if (mode === 'nochange') {
      console.log('No changes. Your infrastructure matches the configuration.');
    } else {
      console.log('  # aws_instance.db will be created');
      console.log('Plan: 9 to add, 0 to change, 0 to destroy.');
    }
    break;
  }
  case 'apply':
    console.log('aws_instance.db: Creating...');
    if (mode === 'slowapply') {
      for (let i = 0; i < 3; i += 1) {
        await sleep(300);
        console.log(`aws_instance.db: Still creating... [${i}s elapsed]`);
      }
    }
    console.log('Apply complete! Resources: 9 added, 0 changed, 0 destroyed.');
    if (process.env.FAKE_TF_LOG)
      appendFileSync(process.env.FAKE_TF_LOG, `${JSON.stringify({ command: 'apply-finished' })}\n`);
    break;
  case 'output':
    console.log(
      JSON.stringify({
        urls: {
          value: {
            frontend: `${health}/`,
            api: `${health}/core/api/v1`,
            frontend_health: `${health}/healthz`,
            backend_health: `${health}/core/api/v1/health`,
          },
          sensitive: false,
        },
        instance_ids: { value: { frontend: 'i-11111111111111111', backend: 'i-22222222222222222', db: 'i-33333333333333333' }, sensitive: false },
        private_ips: { value: { frontend: '10.0.1.10', backend: '10.0.2.10', db: '10.0.2.20' }, sensitive: false },
        db_volume_id: { value: 'vol-44444444444444444', sensitive: false },
        suspended: { value: false, sensitive: false },
        secret_thing: { value: 'no-debe-aparecer', sensitive: true },
      }),
    );
    break;
  default:
    console.error(`fake-terraform: comando no simulado ${command}`);
    process.exit(2);
}
