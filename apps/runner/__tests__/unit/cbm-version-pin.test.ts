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
    // Indented: the block runs inside a subshell so its failures can't abort install.sh.
    const installVersion = match(installSh, /^\s*CBM_VERSION="([^"]+)"/m);
    expect(installVersion).toBe(dockerVersion);
  });

  it('pins the same linux checksums in the Dockerfile and install.sh', () => {
    for (const arch of ['AMD64', 'ARM64'] as const) {
      const dockerSha = match(dockerfile, new RegExp(`^ARG CBM_SHA256_${arch}=(\\S+)`, 'm'));
      const installSha = match(installSh, new RegExp(`^\\s*CBM_SHA256_LINUX_${arch}="([^"]+)"`, 'm'));
      expect(installSha).toBe(dockerSha);
    }
  });

  it('declares a checksum for every platform install.sh can download', () => {
    const shaNames = [...installSh.matchAll(/^\s*CBM_SHA256_([A-Z0-9_]+)="([0-9a-f]{64})"/gm)].map(m => m[1]);
    expect(shaNames.sort()).toEqual([
      'DARWIN_AMD64',
      'DARWIN_ARM64',
      'LINUX_AMD64',
      'LINUX_ARM64',
    ]);
  });

  it('declares four distinct checksums', () => {
    // The unit suite cannot reach the network, so it cannot prove a checksum
    // matches upstream — scripts/verify-cbm-pin.sh does that in CI. What it CAN
    // catch is the copy-paste failure that mutation-testing exposed: bumping the
    // version and leaving a platform's hash pointing at the previous release, or
    // pasting one arch's hash over another's.
    const shas = [...installSh.matchAll(/^\s*CBM_SHA256_[A-Z0-9_]+="([0-9a-f]{64})"/gm)].map(m => m[1]);
    expect(shas).toHaveLength(4);
    expect(new Set(shas).size).toBe(4);
  });

  it('upgrades in place instead of skipping when the installed version differs', () => {
    // A bare `--version` presence check makes every future pin bump a no-op on
    // workspaces that already have the old binary.
    // It must read the installed binary's own version and compare it to the pin,
    // not merely check that some binary exists at the path.
    expect(installSh).toMatch(/--version[^\n]*\|[^\n]*awk/);
    expect(installSh).toMatch(/"\$installed"\s*=\s*"\$CBM_VERSION"/);
    // Provision failure must not abort the installer (a startup script gates on it).
    expect(installSh).toMatch(/if\s+!\s+cbm_provision/);
  });
});
