import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The CBM binary pin lives in two places that provision different surfaces:
 * docker/worker/Dockerfile (the Coder worker image) and apps/runner/install.sh
 * (what actually runs on existing workspaces, since the image is never pushed —
 * see .github/workflows/worker-image.yml). A version or checksum that moves in
 * one file but not the other silently produces two different binaries in the
 * fleet, and CBM's daemon rejects a mismatched build fingerprint on a shared
 * cache root.
 */

const REPO_ROOT = join(import.meta.dir, '../../../..');
const dockerfile = readFileSync(join(REPO_ROOT, 'docker/worker/Dockerfile'), 'utf8');
const installSh = readFileSync(join(REPO_ROOT, 'apps/runner/install.sh'), 'utf8');

function match(source: string, pattern: RegExp): string {
  const found = source.match(pattern);
  if (!found) throw new Error(`pattern not found: ${pattern}`);
  return found[1];
}

describe('CBM version pin', () => {
  it('pins the same version in the Dockerfile and install.sh', () => {
    const dockerVersion = match(dockerfile, /^ARG CBM_VERSION=(\S+)/m);
    const installVersion = match(installSh, /^CBM_VERSION="([^"]+)"/m);
    expect(installVersion).toBe(dockerVersion);
  });

  it('pins the same linux checksums in the Dockerfile and install.sh', () => {
    for (const arch of ['AMD64', 'ARM64'] as const) {
      const dockerSha = match(dockerfile, new RegExp(`^ARG CBM_SHA256_${arch}=(\\S+)`, 'm'));
      const installSha = match(installSh, new RegExp(`^CBM_SHA256_LINUX_${arch}="([^"]+)"`, 'm'));
      expect(installSha).toBe(dockerSha);
    }
  });

  it('declares a checksum for every platform install.sh can download', () => {
    const shaNames = [...installSh.matchAll(/^CBM_SHA256_([A-Z0-9_]+)="([0-9a-f]{64})"/gm)].map(m => m[1]);
    expect(shaNames.sort()).toEqual([
      'DARWIN_AMD64',
      'DARWIN_ARM64',
      'LINUX_AMD64',
      'LINUX_ARM64',
    ]);
  });

  it('upgrades in place instead of skipping when the installed version differs', () => {
    // A bare `--version` presence check makes every future pin bump a no-op on
    // workspaces that already have the old binary.
    expect(installSh).toMatch(/CBM_INSTALLED_VERSION/);
    expect(installSh).toMatch(/\$CBM_INSTALLED_VERSION"?\s*=\s*"?\$?\{?CBM_VERSION/);
  });
});
