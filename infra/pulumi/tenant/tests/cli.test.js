// Optional CLI contract probe: local file backend and a component, never AWS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { summarizePulumiPreview } from '../../../../platform/platform_api/src/engines/pulumi.js';
import { runCommand } from '../../../../platform/platform_api/src/worker/services/command-runner.js';
const require = createRequire(import.meta.url);
const bin = process.env.PULUMI_BIN || 'pulumi';
const available = spawnSync(bin, ['version'], { encoding: 'utf8', windowsHide: true,
  env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: 'true' }, timeout: 30000 });

test('installed CLI accepts real JSON previews and saved plans on a local component stack',
  { skip: available.error?.code === 'ENOENT', timeout: 600000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulumi-cli-probe-'));
    const backend = await mkdtemp(join(tmpdir(), 'pulumi-local-state-'));
    const env = { ...process.env, PULUMI_BACKEND_URL: pathToFileURL(backend).href,
      PULUMI_CONFIG_PASSPHRASE: 'local-test-only', PULUMI_SKIP_UPDATE_CHECK: 'true',
      PULUMI_ENABLE_STREAMING_JSON_PREVIEW: 'false' };
    delete env.NODE_TEST_CONTEXT;
    const run = async args => {
      const output = await runCommand({ command: bin, args: [...args, '--non-interactive', '--color', 'never'],
        cwd: directory, env: { ...env, NODE_TEST_CONTEXT: undefined }, captureStdout: true,
        logStdout: false, timeoutMs: 300000 });
      return output.stdout;
    };
    try {
      await writeFile(join(directory, 'Pulumi.yaml'), 'name: attendance-cli-probe\nruntime:\n  name: nodejs\n  options:\n    typescript: false\n');
      await writeFile(join(directory, 'package.json'), '{"name":"cli-probe","main":"index.js","type":"module"}');
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'), 'junction');
      await writeFile(join(directory, 'index.js'), `import * as pulumi from ${JSON.stringify(pathToFileURL(require.resolve('@pulumi/pulumi')).href)};\nnew pulumi.ComponentResource('test:component:Probe', 'probe');\nexport const safe = 'local-only';\n`);
      await run(['stack', 'select', 'probe-test', '--create', '--secrets-provider', 'passphrase']);
      const data = JSON.parse(await run(['preview', '--json', '--save-plan', join(directory, 'saved-plan.json')]));
      const summary = summarizePulumiPreview(data);
      assert.equal(summary.totals.create, 1);
      assert.equal(summary.data_volumes_deleted.length, 0);
      await run(['up', '--yes', '--skip-preview', '--plan', join(directory, 'saved-plan.json'), '--suppress-outputs']);
      const checkpoint = JSON.parse(await run(['stack', 'export']));
      assert.ok(checkpoint.deployment.resources.some(resource => resource.type === 'test:component:Probe'));
      await run(['destroy', '--yes', '--skip-preview', '--suppress-outputs']);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(backend, { recursive: true, force: true });
    }
  });
