/**
 * A runner install or self-update must resolve exactly what the repo's bun.lock
 * pins, never whatever npm serves that minute. It used to resolve fresh: the
 * sparse checkout left bun.lock out, and `bun install --frozen-lockfile` with no
 * lockfile at all resolves against the registry without complaint. When an
 * upstream release depended on a version npm had not published yet, every
 * runner update failed on "No version matching ... found".
 *
 * So the installers check out the repo's own `/bun.lock` and `/package.json`
 * (anchored: an unanchored `package.json` pattern also checks out every other
 * app's manifest, which pulls their dependencies into the runner) and install
 * frozen. The root package.json is not rewritten: a rewritten one drops the
 * repo's `overrides`, and bun then refuses the lockfile as changed.
 *
 * The end-to-end proof is .github/workflows/installer-smoke.yml.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '../../../..');
const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();
const installPs1 = (await Bun.file(join(import.meta.dir, '../../install.ps1')).text()).replace(/\r\n/g, '\n');

const sparse = (installSh.match(/<< 'SPARSE'\n([\s\S]*?)\nSPARSE/)?.[1] ?? '')
  .split('\n').map((l) => l.trim()).filter(Boolean);

/** Command lines (not comments, not messages) that run `bun install`. */
function bunInstallCommands(script: string): string[] {
  return script.split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bbun install\b/.test(l) && !l.startsWith('#') && !/^(echo|Write-Host|printf)\b/.test(l) && !/\becho\b.*bun install/.test(l));
}

describe('installers check out the pinned lockfile', () => {
  test('the sparse list carries the repo root bun.lock and package.json, anchored', () => {
    expect(sparse).toContain('/bun.lock');
    expect(sparse).toContain('/package.json');
    expect(sparse).not.toContain('package.json');
  });

  test('neither installer rewrites the root package.json', () => {
    expect(installSh).not.toContain('"$INSTALL_DIR/package.json"');
    expect(installPs1).not.toContain('Set-Content "$InstallDir\\package.json"');
  });

  test('every bun install in either installer is frozen', () => {
    for (const script of [installSh, installPs1]) {
      const cmds = bunInstallCommands(script);
      expect(cmds.length).toBeGreaterThan(0);
      for (const cmd of cmds) expect(cmd).toContain('--frozen-lockfile');
    }
  });
});

type Manifest = { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; overrides?: Record<string, string> };

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const deps = (m: Manifest) => Object.fromEntries(DEP_FIELDS.map((f) => [f, m[f] ?? {}]));

describe('bun.lock covers the runner tree a sparse install checks out', () => {
  // A frozen install fails (and the update rolls back) when any manifest in the
  // installed tree disagrees with bun.lock, so the lockfile has to match every
  // one the sparse list checks out: the root and each workspace directory.
  test('every checked-out workspace manifest matches its bun.lock entry', async () => {
    const lock = Bun.JSONC.parse(await Bun.file(join(repoRoot, 'bun.lock')).text()) as { workspaces: Record<string, Manifest>; overrides?: Record<string, string> };
    const dirs = sparse.filter((p) => /^(apps|packages)\/[^/]+\/$/.test(p)).map((p) => p.slice(0, -1));
    expect(dirs).toContain('apps/runner');

    const rootPkg: Manifest = await Bun.file(join(repoRoot, 'package.json')).json();
    expect(lock.overrides ?? {}).toEqual(rootPkg.overrides ?? {});
    for (const dir of ['', ...dirs]) {
      const pkg: Manifest = await Bun.file(join(repoRoot, dir, 'package.json')).json();
      const entry = lock.workspaces[dir];
      expect(entry, `bun.lock has no workspace entry for "${dir}"; run bun install and commit bun.lock`).toBeDefined();
      expect(deps(entry), `bun.lock is stale for "${dir || '<root>'}"; run bun install and commit bun.lock`).toEqual(deps(pkg));
    }
  });
});
