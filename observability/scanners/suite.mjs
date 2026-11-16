import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const images = {
  Checkov: 'bridgecrew/checkov:3.4.5',
  Trivy: 'aquasec/trivy:0.76.2',
  Gitleaks: 'ghcr.io/gitleaks/gitleaks:v8.30.1',
};

const field = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 220);
const relative = (value) => field(value).replace(/^\/?scan\//, '').replace(/^\//, '');

export function scanFindings(scanner, report) {
  if (scanner === 'Checkov') {
    const frameworks = Array.isArray(report) ? report : [report];
    if (!frameworks.length || frameworks.some(({ results }) =>
      !Array.isArray(results?.failed_checks) || results.parsing_errors?.length)) throw new Error('Informe de IaC incompleto');
    return frameworks.flatMap(({ results }) => results.failed_checks.map((item) =>
      `${field(item.check_id)} · ${relative(item.file_path)} · ${field(item.resource)}`));
  }
  if (scanner === 'Trivy') {
    const reports = report.Results ?? [];
    if (!reports.some((result) => result.Type === 'pnpm')) throw new Error('Trivy no reconoció pnpm-lock.yaml');
    return reports.flatMap(({ Target, Vulnerabilities = [] }) => Vulnerabilities.map((item) =>
      `${field(item.Severity)} · ${field(item.VulnerabilityID)} · ${field(item.PkgName)} ${field(item.InstalledVersion)} · ${relative(Target)}`));
  }
  if (!Array.isArray(report)) throw new Error('Informe de secretos inválido');
  return report.map((item) => `${field(item.RuleID)} · ${relative(item.File)}:${Number(item.StartLine) || 0}`);
}

export async function runScanSuite({ runCommand, repo, coreRef, signal, onResult }) {
  const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git';
  const root = await mkdtemp(join(tmpdir(), 'attendance-p5-'));
  const source = join(root, 'source');
  const dependencies = join(root, 'dependencies');
  const command = (command, args, options = {}) => runCommand({
    command, args, signal, captureStdout: true, logStdout: false,
    timeoutMs: 8 * 60_000, maxOutputBytes: 32 * 1024 * 1024, maxLineBytes: 2 * 1024 * 1024,
    ...options,
  });
  async function docker(scanner, folder, args, options = {}) {
    const name = `${basename(root).toLowerCase()}-${scanner.toLowerCase()}`;
    try {
      return await command('docker', [
        'run', '--rm', '--name', name, '--mount', `type=bind,source=${folder},target=/scan,readonly`,
        ...(scanner === 'Trivy'
          ? ['--mount', 'type=volume,source=attendance-p5-trivy-cache,target=/root/.cache/trivy']
          : ['--network', 'none']),
        images[scanner], ...args,
      ], options);
    } catch (error) {
      // Terminating the CLI may leave a container behind on Docker Desktop.
      await command('docker', ['container', 'rm', '--force', name], {
        signal: undefined, timeoutMs: 5000,
      }).catch(() => {});
      throw error;
    }
  }

  async function run(scanner, target, execute) {
    let result;
    try {
      const findings = scanFindings(scanner, JSON.parse(await execute()));
      result = { scanner, target, status: findings.length ? 'findings' : 'clean', count: findings.length, findings: findings.slice(0, 100) };
    } catch {
      signal?.throwIfAborted();
      result = { scanner, target, status: 'error', count: 0, findings: [] };
    }
    await onResult(result);
  }

  async function prepareSource() {
    const archive = join(root, 'source.tar');
    const commit = (await command(git, ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    await mkdir(source);
    await command(git, ['-C', repo, 'archive', '--format=tar', `--output=${archive}`, commit]);
    await command('tar', ['-xf', archive, '-C', source]);
    return commit;
  }

  try {
    // A fixed snapshot excludes untracked .env, local state and repository credentials.
    const commit = await prepareSource().catch(() => null);
    signal?.throwIfAborted();
    await run('Checkov', commit ? `attendance-platform@${commit}` : 'attendance-platform', async () => {
      if (!commit) throw new Error('Sin snapshot');
      const { stdout } = await docker('Checkov', source, [
        '-d', '/scan/infra', '--framework', 'terraform', 'cloudformation',
        '--output', 'json', '--quiet', '--compact', '--soft-fail', '--skip-download',
      ]);
      return stdout;
    });
    await run('Trivy', `attendance-core@${coreRef || 'sin revisión configurada'}`, async () => {
      if (!/^[0-9a-f]{40}$/i.test(coreRef ?? '')) throw new Error('Falta el commit del backend');
      const core = resolve(repo, '../attendance-core');
      await mkdir(dependencies);
      for (const file of ['package.json', 'pnpm-lock.yaml']) {
        const { stdout } = await command(git, ['-C', core, 'show', `${coreRef}:${file}`]);
        await writeFile(join(dependencies, file), stdout, 'utf8');
      }
      const { stdout } = await docker('Trivy', dependencies, [
        'fs', '--scanners', 'vuln', '--quiet', '--format', 'json', '--timeout', '6m', '/scan',
      ]);
      return stdout;
    });
    await run('Gitleaks', commit ? `attendance-platform@${commit}` : 'attendance-platform', async () => {
      if (!commit) throw new Error('Sin snapshot');
      const { exitCode, stdout } = await docker('Gitleaks', source, [
        'dir', '/scan', '--no-banner', '--redact=100', '--report-format=json', '--report-path=/dev/stdout', '--exit-code=3',
      ], { acceptedExitCodes: [0, 3] });
      // Gitleaks omite el informe si no encuentra coincidencias.
      return exitCode === 0 && !stdout.trim() ? '[]' : stdout;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
