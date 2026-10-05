/**
 * install.sh clones a SPARSE tree and rewrites the root workspaces list. Every
 * workspace package the runner resolves — directly or transitively — must be in
 * both, or `bun install` fails on "@buildd/<pkg>@workspace:* failed to resolve"
 * and `set -e` exits before the launcher is written (every fresh install broke
 * this way when @buildd/core became a runner dependency).
 *
 * The end-to-end proof is .github/workflows/installer-smoke.yml; this is the
 * fast, offline guard for the same invariant.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '../../../..');
const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();

const sparseBlock = installSh.match(/write_sparse_checkout\(\) \{\n  cat > \.git\/info\/sparse-checkout << 'SPARSE'\n([\s\S]*?)\nSPARSE/)?.[1] ?? '';
const sparse = sparseBlock.split('\n').map((l) => l.trim()).filter(Boolean);

const pkgJsonBlock = installSh.match(/cat > "\$INSTALL_DIR\/package.json" << 'PKGJSON'\n([\s\S]*?)\nPKGJSON/)?.[1] ?? '';
const workspaces: string[] = pkgJsonBlock ? JSON.parse(pkgJsonBlock).workspaces : [];

/** name -> dir for every workspace package in the repo. */
async function workspaceDirs(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const pattern of ['apps/*/package.json', 'packages/*/package.json']) {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: repoRoot })) {
      const pkg = await Bun.file(join(repoRoot, rel)).json();
      out.set(pkg.name, rel.replace(/\/package\.json$/, ''));
    }
  }
  return out;
}

async function runnerWorkspaceClosure(): Promise<string[]> {
  const dirs = await workspaceDirs();
  const seen = new Set<string>(['apps/runner']);
  const queue = ['apps/runner'];
  while (queue.length) {
    const dir = queue.shift()!;
    const pkg = await Bun.file(join(repoRoot, dir, 'package.json')).json();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
      const depDir = dirs.get(name);
      if (depDir && !seen.has(depDir)) {
        seen.add(depDir);
        queue.push(depDir);
      }
    }
  }
  return [...seen].sort();
}

describe('install.sh sparse tree', () => {
  test('sparse checkout and workspaces blocks are found', () => {
    expect(sparse.length).toBeGreaterThan(0);
    expect(workspaces.length).toBeGreaterThan(0);
  });

  test('every workspace package the runner resolves is checked out', async () => {
    for (const dir of await runnerWorkspaceClosure()) {
      expect(sparse).toContain(`${dir}/`);
    }
  });

  test('every workspace package the runner resolves is in the rewritten workspaces list', async () => {
    expect([...workspaces].sort()).toEqual(await runnerWorkspaceClosure());
  });

  test('the server-only preload ships, and the launcher passes it explicitly', () => {
    expect(sparse).toContain('scripts/stub-server-only.ts');
    // The updater's health probe boots from the install dir and relies on the root bunfig.
    expect(sparse).toContain('bunfig.toml');
    expect(installSh).toContain('BUILDD_PRELOAD="$HOME/.buildd/scripts/stub-server-only.ts"');
    expect(installSh).toContain('bun --preload "$BUILDD_PRELOAD" run "$HOME/.buildd/apps/runner/src/index.ts" "$@"');
  });

  test('the installed ref is selectable (CI installs the commit under test)', () => {
    expect(installSh).toContain('BUILDD_REF="${BUILDD_REF:-main}"');
    expect(installSh).toContain('git fetch --depth 1 origin "$BUILDD_REF"');
  });

  test('no bare sudo: every sudo is announced or behind an explicit check', () => {
    const sudoLines = installSh
      .split('\n')
      .filter((l) => /\bsudo\b/.test(l) && !l.trim().startsWith('#') && !l.includes('echo') && !l.includes('printf'));
    for (const line of sudoLines) {
      // Allowed: probes (`sudo -n true`, `command -v sudo`), and the guarded $CBM_SUDO / CBM_SUDO="sudo".
      expect(line).toMatch(/sudo -n true|command -v sudo|CBM_SUDO/);
    }
  });
});
