/**
 * Regression: `installWorkspaceDeps` ran `bun install` at the worktree ROOT,
 * unconditionally, for every repo the runner clones — and returned
 * `Promise<void>`, so nothing downstream could tell it had failed.
 *
 * The measured failure was `Bun could not find a package.json file to install
 * from`: the worktree root has no manifest at all. A missing manifest is not
 * lockfile drift, so the frozen→unfrozen retry could not help; it rescued
 * almost nothing, doubled the stall, and the warning text blamed the lockfile.
 *
 * `autoDetectManifest` already had the lockfile→toolchain table, but probed
 * exactly one directory. `detectInstallPlans` generalises it to a depth-capped,
 * root-lockfile-first plan that excludes `node_modules` and dot-directories.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-install-detect.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  detectInstallPlans,
  autoDetectManifest,
  MAX_INSTALL_DIRS,
  type InstallProbe,
} from '../../src/env-verify';

/**
 * Build an `InstallProbe` from a flat list of repo-relative file paths, so a
 * fixture reads like an `ls -R` and never touches the real filesystem.
 */
function probeFor(files: string[]): InstallProbe {
  const set = new Set(files);
  return {
    exists: (rel) => set.has(rel),
    listDirs: (rel) => {
      const prefix = rel === '.' ? '' : `${rel}/`;
      const out = new Set<string>();
      for (const f of set) {
        if (prefix && !f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const seg = rest.split('/');
        if (seg.length > 1) out.add(seg[0]);
      }
      return [...out];
    },
  };
}

describe('detectInstallPlans', () => {
  test('resolves a NESTED manifest when the root has none', () => {
    const plans = detectInstallPlans('/wt', probeFor([
      'packages/api/package.json',
      'packages/api/bun.lock',
      'README.md',
    ]));

    expect(plans).toEqual([
      { dir: 'packages/api', runtime: 'bun', install: 'bun install --frozen-lockfile', lockfile: 'bun.lock' },
    ]);
  });

  test('a root lockfile wins outright — one install at the root, no per-package fan-out', () => {
    // The workspace case: the root install links every workspace package,
    // which is the whole point of the runner's call.
    const plans = detectInstallPlans('/wt', probeFor([
      'package.json',
      'bun.lock',
      'packages/core/package.json',
      'packages/core/bun.lock',
      'apps/web/package.json',
    ]));

    expect(plans).toEqual([
      { dir: '.', runtime: 'bun', install: 'bun install --frozen-lockfile', lockfile: 'bun.lock' },
    ]);
  });

  test('nothing installable anywhere yields no plans', () => {
    expect(detectInstallPlans('/wt', probeFor(['README.md', 'docs/spec.md']))).toEqual([]);
  });

  test('never descends into node_modules, .git or any dot-directory', () => {
    const plans = detectInstallPlans('/wt', probeFor([
      'node_modules/left-pad/package.json',
      'node_modules/left-pad/bun.lock',
      '.git/hooks/package.json',
      '.buildd-worktrees/other/package.json',
      '.buildd-worktrees/other/bun.lock',
      'src/index.ts',
    ]));

    expect(plans).toEqual([]);
  });

  test('drops a candidate nested inside another candidate', () => {
    const plans = detectInstallPlans('/wt', probeFor([
      'services/api/package.json',
      'services/api/bun.lock',
      'services/api/tools/package.json',
      'services/api/tools/bun.lock',
    ]));

    expect(plans.map(p => p.dir)).toEqual(['services/api']);
  });

  test('caps the number of install directories', () => {
    const files: string[] = [];
    for (let i = 0; i < MAX_INSTALL_DIRS + 3; i++) {
      files.push(`pkg${i}/package.json`, `pkg${i}/bun.lock`);
    }

    const plans = detectInstallPlans('/wt', probeFor(files));

    expect(plans.length).toBe(MAX_INSTALL_DIRS);
  });

  test('respects the depth cap', () => {
    const deep = 'a/b/c/d/package.json';
    expect(detectInstallPlans('/wt', probeFor([deep, 'a/b/c/d/bun.lock']), 3).map(p => p.dir))
      .toEqual([]);
    expect(detectInstallPlans('/wt', probeFor([deep, 'a/b/c/d/bun.lock']), 4).map(p => p.dir))
      .toEqual(['a/b/c/d']);
  });

  test('falls back to a bare package.json (no lockfile) at shallow depth', () => {
    const plans = detectInstallPlans('/wt', probeFor(['app/package.json']));
    expect(plans.map(p => p.dir)).toEqual(['app']);
    expect(plans[0].lockfile).toBe('');
  });

  test('reports a non-bun toolchain honestly rather than claiming bun', () => {
    const plans = detectInstallPlans('/wt', probeFor(['Cargo.toml', 'Cargo.lock']));
    expect(plans.map(p => p.runtime)).toEqual(['cargo']);
  });
});

describe('autoDetectManifest keeps its contract', () => {
  test('still root-only, still first-match-wins', () => {
    const m = autoDetectManifest('/wt', (p) => p === 'bun.lock');
    expect(m).toEqual({ toolchain: { runtime: 'bun' }, install: { command: 'bun install --frozen-lockfile' } });
  });

  test('a nested-only lockfile is NOT a root manifest', () => {
    expect(autoDetectManifest('/wt', (p) => p === 'packages/api/bun.lock')).toBeNull();
  });

  test('null when nothing recognisable is at the root', () => {
    expect(autoDetectManifest('/wt', () => false)).toBeNull();
  });
});
