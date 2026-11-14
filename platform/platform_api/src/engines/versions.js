// Datos comunes del registro de versiones (RF-13) para todos los motores.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Commit corto del repo; "-dirty" si hay cambios locales en `paths`. null si no hay git. */
export async function templatesCommit(cwd, paths = ['.']) {
  try {
    const { stdout: commit } = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    const { stdout: dirty } = await exec('git', ['status', '--porcelain', '--', ...paths], { cwd });
    return `${commit.trim()}${dirty.trim() ? '-dirty' : ''}`;
  } catch {
    return null;
  }
}

export function imageVersions(input) {
  return {
    image_version: input.image?.version ?? null,
    image_git_commit: input.image?.git_commit ?? null,
  };
}
