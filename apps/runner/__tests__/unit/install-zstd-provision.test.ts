/**
 * The warm-repo cloud-runner feature (apps/runner/src/warm-repo.ts) spawns the
 * real `zstd` CLI to compress/restore the cache tarball; its unit tests do the
 * same to exercise that path for real, so a sandbox without the binary fails
 * those tests even though nothing else in the installer needs it. install.sh
 * is "the real upgrade path for the fleet" (see cbm-version-pin.test.ts) — this
 * checks it provisions zstd the same best-effort, non-fatal way it provisions
 * CBM, rather than leaving it to whatever happens to be on the base image.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const installSh = readFileSync(join(REPO_ROOT, 'apps/runner/install.sh'), 'utf8');

describe('install.sh zstd provisioning', () => {
  it('skips the install when zstd is already on PATH', () => {
    expect(installSh).toMatch(/zstd_provision\s*\(\)\s*\{[\s\S]*?command -v zstd/);
  });

  it('is called as a guarded, non-fatal step like CBM provisioning', () => {
    expect(installSh).toMatch(/if ! zstd_provision; then/);
  });

  it('tries apt-get on Linux and brew on macOS, without hard-requiring either', () => {
    expect(installSh).toContain('apt-get install -y');
    expect(installSh).toContain('brew install');
  });

  it('never types the word sudo for a check that already passes (idempotent)', () => {
    // The function must return before reaching any install command when zstd exists.
    const fn = installSh.match(/zstd_provision\s*\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const checkIdx = fn.indexOf('command -v zstd');
    const installIdx = fn.search(/apt-get install|brew install/);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(checkIdx);
  });
});
