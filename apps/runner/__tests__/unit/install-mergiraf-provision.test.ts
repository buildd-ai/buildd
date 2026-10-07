/**
 * The merge-drivers.test.ts mergiraf tests spawn the real `mergiraf` CLI for
 * language-aware structural merge resolution; the test that checks a
 * both-sides-identical addition appears once is skipped when the binary is
 * absent. install.sh provisions mergiraf best-effort, non-fatal way, with
 * SHA256 verification of the pinned release.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const installSh = readFileSync(join(REPO_ROOT, 'apps/runner/install.sh'), 'utf8');

describe('install.sh mergiraf provisioning', () => {
  it('skips the install when mergiraf is already on PATH', () => {
    expect(installSh).toMatch(/mergiraf_provision\s*\(\)\s*\{[\s\S]*?command -v mergiraf/);
  });

  it('is called as a guarded, non-fatal step', () => {
    expect(installSh).toMatch(/if ! mergiraf_provision; then/);
  });

  it('downloads from a pinned Codeberg release with SHA256 verification', () => {
    expect(installSh).toContain('codeberg.org/mergiraf/mergiraf/releases/download');
    expect(installSh).toContain('sha256sum -c');
  });

  it('is platform-gated to x86_64 (other arches fail gracefully)', () => {
    expect(installSh).toMatch(/uname -m.*x86_64/);
  });

  it('never reaches a download for a check that already passes (idempotent)', () => {
    const fn = installSh.match(/mergiraf_provision\s*\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const checkIdx = fn.indexOf('command -v mergiraf');
    const downloadIdx = fn.indexOf('curl -fsSL');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(downloadIdx).toBeGreaterThan(checkIdx);
  });

  it('has a pinned version and SHA256 for reproducibility', () => {
    const fn = installSh.match(/mergiraf_provision\s*\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fn).toMatch(/MERGIRAF_VERSION="0\.20\.0"/);
    expect(fn).toMatch(/MERGIRAF_SHA256="4341127da8d1da29eced669fbacc1e5d6e530115098de0b82cc9dc551a1acf37"/);
  });

  it('cleans up temporary files on success and failure', () => {
    const fn = installSh.match(/mergiraf_provision\s*\(\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fn).toMatch(/rm -rf.*TMPDIR_MERGIRAF/);
  });
});
