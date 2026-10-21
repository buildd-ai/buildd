import { describe, test, expect } from 'bun:test';
import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { requiredWorkspaceDirs, widenSparseCheckout } from '../../src/updater';

// A release that adds a workspace package the runner imports (through core)
// must not strand a sparse install: after the reset the updater adds the new
// package directory before the frozen reinstall.

const pkg = (name: string, deps: Record<string, string> = {}) => JSON.stringify({ name, dependencies: deps });

describe('requiredWorkspaceDirs', () => {
  test('follows workspace dependencies transitively, by package name, and ignores registry deps', () => {
    const m = new Map([
      ['apps/runner', pkg('@buildd/runner', { '@buildd/core': 'workspace:*', '@buildd/shared': 'workspace:*', zod: '^4' })],
      ['packages/core', pkg('@buildd/core', { '@buildd/spec-contract': 'workspace:*', '@buildd/ai-kit': 'workspace:*' })],
      ['packages/shared', pkg('@buildd/shared')],
      ['packages/spec-contract', pkg('@buildd/spec-contract')],
      ['packages/ai-kit', pkg('@buildd/ai-kit', { '@buildd/shared': 'workspace:*' })],
      ['packages/web-only', pkg('@buildd/web-only')],
    ]);
    expect(requiredWorkspaceDirs(m)).toEqual(['packages/ai-kit', 'packages/core', 'packages/shared', 'packages/spec-contract']);
  });

  test('an unreadable manifest is skipped, not fatal', () => {
    expect(requiredWorkspaceDirs(new Map([['apps/runner', '{nope'], ['packages/core', pkg('@buildd/core')]]))).toEqual([]);
  });
});

const git = async (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(root: string, rel: string, text: string) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe('widenSparseCheckout, against real git', () => {
  test('a sparse install gets the new package; a full checkout is untouched', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'upd-sparse-origin-'));
    const sh = (c: string, cwd = origin) => execSync(c, { cwd, stdio: 'pipe' });
    sh('git init -q -b main && git config user.email a@b.c && git config user.name t');
    write(origin, 'apps/runner/package.json', pkg('@buildd/runner', { '@buildd/core': 'workspace:*' }));
    write(origin, 'packages/core/package.json', pkg('@buildd/core'));
    write(origin, 'apps/web/package.json', pkg('@buildd/web'));
    write(origin, 'apps/web/src/page.tsx', 'export {};\n');
    sh('git add -A && git commit -qm v1');

    const install = mkdtempSync(join(tmpdir(), 'upd-sparse-install-'));
    const ish = (c: string) => execSync(c, { cwd: install, stdio: 'pipe' });
    ish(`git init -q && git remote add origin ${origin} && git config core.sparseCheckout true`);
    writeFileSync(join(install, '.git/info/sparse-checkout'), 'apps/runner/\npackages/core/\npackage.json\n');
    ish('git fetch -q origin main && git checkout -q -B main origin/main');
    expect(existsSync(join(install, 'apps/web/src/page.tsx'))).toBe(false);

    // The release: core now depends on a new workspace package.
    write(origin, 'packages/core/package.json', pkg('@buildd/core', { '@buildd/spec-contract': 'workspace:*' }));
    write(origin, 'packages/spec-contract/package.json', pkg('@buildd/spec-contract'));
    write(origin, 'packages/spec-contract/src/index.ts', 'export {};\n');
    sh('git add -A && git commit -qm v2');
    ish('git fetch -q origin main && git reset -q --hard origin/main');
    expect(existsSync(join(install, 'packages/spec-contract/src/index.ts'))).toBe(false);

    expect(await widenSparseCheckout(install, git)).toEqual(['packages/spec-contract']);
    expect(existsSync(join(install, 'packages/spec-contract/src/index.ts'))).toBe(true);
    expect(existsSync(join(install, 'apps/web/src/page.tsx'))).toBe(false);
    // Idempotent.
    expect(await widenSparseCheckout(install, git)).toEqual([]);

    // A full clone has no sparse config: nothing to do.
    expect(await widenSparseCheckout(origin, git)).toEqual([]);
  });
});

// An install made before the sparse list carried bun.lock has no lockfile, and
// `bun install --frozen-lockfile` then resolves fresh from npm. The update adds it.
describe('ensureLockfileCheckedOut, against real git', () => {
  test('an older sparse install gets the root bun.lock; a full checkout is untouched', async () => {
    const { ensureLockfileCheckedOut } = await import('../../src/updater');
    const origin = mkdtempSync(join(tmpdir(), 'upd-lock-origin-'));
    const sh = (c: string, cwd = origin) => execSync(c, { cwd, stdio: 'pipe' });
    sh('git init -q -b main && git config user.email a@b.c && git config user.name t');
    write(origin, 'package.json', pkg('buildd'));
    write(origin, 'bun.lock', '{}\n');
    write(origin, 'apps/runner/package.json', pkg('@buildd/runner'));
    write(origin, 'apps/web/bun.lock', '{}\n');
    sh('git add -A && git commit -qm v1');

    const install = mkdtempSync(join(tmpdir(), 'upd-lock-install-'));
    const ish = (c: string) => execSync(c, { cwd: install, stdio: 'pipe' });
    ish(`git init -q && git remote add origin ${origin} && git config core.sparseCheckout true`);
    writeFileSync(join(install, '.git/info/sparse-checkout'), 'apps/runner/\npackage.json\n');
    ish('git fetch -q origin main && git checkout -q -B main origin/main');
    expect(existsSync(join(install, 'bun.lock'))).toBe(false);
    // What the old unfrozen `bun install` left behind: a lockfile it resolved itself.
    writeFileSync(join(install, 'bun.lock'), 'resolved fresh\n');

    expect(await ensureLockfileCheckedOut(install, git)).toBe(true);
    expect(readFileSync(join(install, 'bun.lock'), 'utf8').replace(/\r\n/g, '\n')).toBe('{}\n');
    // Anchored: only the root lockfile, not one that happens to sit in another app.
    expect(existsSync(join(install, 'apps/web/bun.lock'))).toBe(false);
    // Idempotent.
    expect(await ensureLockfileCheckedOut(install, git)).toBe(false);
    expect(await ensureLockfileCheckedOut(origin, git)).toBe(false);
  });
});

describe('applyUpdate', () => {
  test('checks out the lockfile after the reset and before the reinstall', async () => {
    const { applyUpdate } = await import('../../src/updater');
    const order: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'upd-home-'));
    const result = await applyUpdate(home, require('fs'), {
      git: async (args: string[]) => {
        order.push(`git ${args.join(' ')}`);
        if (args[0] === 'config') return 'true';
        if (args[0] === 'sparse-checkout' && args[1] === 'list') return 'apps/runner\npackage.json';
        if (args[0] === 'ls-tree') return '';
        if (args[0] === 'show') return pkg('@buildd/runner');
        return 'main';
      },
      bunVersion: async () => {},
      bunInstall: async () => { order.push('bunInstall'); },
    });
    expect(result.success).toBe(true);
    const reset = order.findIndex((o) => o.startsWith('git reset'));
    const add = order.indexOf('git sparse-checkout add /bun.lock');
    expect(reset).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(reset);
    expect(order.indexOf('bunInstall')).toBeGreaterThan(add);
  });


  test('widens the sparse checkout after the reset and before the reinstall', async () => {
    const { applyUpdate } = await import('../../src/updater');
    const order: string[] = [];
    // Always a throwaway dir: the real fs moves node_modules, never a real home's.
    const home = mkdtempSync(join(tmpdir(), 'upd-home-'));
    const result = await applyUpdate(home, require('fs'), {
      git: async (args: string[]) => {
        order.push(`git ${args[0]}${args[0] === 'sparse-checkout' ? ` ${args[1]}` : ''}`);
        if (args[0] === 'config') return 'true';
        if (args[0] === 'sparse-checkout' && args[1] === 'list') return 'apps/runner\npackages/core';
        if (args[0] === 'ls-tree') return 'packages/core\npackages/spec-contract';
        if (args[0] === 'show') {
          const dir = args[1].replace(/^HEAD:/, '').replace(/\/package\.json$/, '');
          return dir === 'apps/runner' ? pkg('@buildd/runner', { '@buildd/core': 'workspace:*' })
            : dir === 'packages/core' ? pkg('@buildd/core', { '@buildd/spec-contract': 'workspace:*' })
            : pkg('@buildd/spec-contract');
        }
        return 'main';
      },
      bunVersion: async () => {},
      bunInstall: async () => { order.push('bunInstall'); },
    });
    expect(result.success).toBe(true);
    const reset = order.indexOf('git reset');
    const add = order.indexOf('git sparse-checkout add');
    expect(reset).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(reset);
    expect(order.indexOf('bunInstall')).toBeGreaterThan(add);
  });
});
