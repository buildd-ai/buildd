import { describe, expect, test } from 'bun:test';
import {
  BASELINE_PATH, COMPOSITION_ROOTS, layerOf, moduleOf, pairs, prune, readBaseline, resolveSpecifier,
  runtimeSpecifiers, scanCoreToModuleEdges, scannedFiles, type Baseline,
} from './module-boundaries';

/**
 * Import-boundary ratchet: core never imports a module.
 *
 * Every runtime import from a core file into a module file is listed, by file
 * pair, in scripts/module-boundaries.baseline.json. This test fails when
 *   - a pair appears that the baseline does not list (a NEW core→module import), or
 *   - the baseline lists a pair that no longer exists (it must shrink with the code).
 * So the list can only get shorter. The scan reads `git ls-files`, hence the
 * entry in scripts/always-run-tests.txt: the file that adds an import is never
 * this test's neighbour.
 *
 * Fixing a failure:
 *   - new pair: don't add the import. Emit a core event a module subscribes to,
 *     move the logic into core, or (if the classifier misfiled the file) fix the
 *     rule in scripts/module-boundaries.ts.
 *   - stale pair: `bun scripts/module-boundaries.ts --prune` and commit the JSON.
 */
const current = scanCoreToModuleEdges();
const baseline = readBaseline();

describe('core → module imports (ratchet)', () => {
  for (const layer of ['backend', 'ui'] as const) {
    test(`${layer}: no core→module import outside ${BASELINE_PATH}`, () => {
      const allowed = new Set(pairs(baseline, layer));
      const added = pairs(current, layer).filter(p => !allowed.has(p));
      expect(added, `new core→module imports. Core reaches modules through hook points, not imports:\n  ${added.join('\n  ')}`).toEqual([]);
    });

    test(`${layer}: every baseline entry still exists (the list only shrinks)`, () => {
      const live = new Set(pairs(current, layer));
      const stale = pairs(baseline, layer).filter(p => !live.has(p));
      expect(stale, `these imports are gone; run \`bun scripts/module-boundaries.ts --prune\`:\n  ${stale.join('\n  ')}`).toEqual([]);
    });
  }

  test('baseline entries record the module the classifier assigns today', () => {
    const wrong: string[] = [];
    for (const layer of ['backend', 'ui'] as const) {
      for (const [from, tos] of Object.entries(baseline[layer])) {
        if (moduleOf(from) !== 'core') wrong.push(`${from} is not core`);
        if (layerOf(from) !== layer) wrong.push(`${from} is not ${layer}`);
        for (const [to, mod] of Object.entries(tos)) if (moduleOf(to) !== mod) wrong.push(`${to}: ${mod} vs ${moduleOf(to)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('composition roots are real, tracked files', () => {
    const files = new Set(scannedFiles());
    for (const f of COMPOSITION_ROOTS) expect(files.has(f), f).toBe(true);
  });
});

describe('the guard sees the files it polices', () => {
  const files = scannedFiles();
  const set = new Set(files);

  test('scans the web app, core and shared packages, and no tests or migrations', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(set.has('apps/web/src/app/api/workers/[id]/route.ts')).toBe(true);
    expect(set.has('apps/web/src/app/api/workers/claim/route.ts')).toBe(true);
    expect(set.has('packages/core/db/schema.ts')).toBe(true);
    expect(set.has('packages/shared/src/types.ts')).toBe(true);
    expect(files.some(f => /\.test\.tsx?$/.test(f))).toBe(false);
    expect(files.some(f => f.startsWith('packages/core/drizzle/'))).toBe(false);
  });

  test('the loop entry points are core and the obvious modules are not', () => {
    for (const f of [
      'apps/web/src/app/api/workers/[id]/route.ts',
      'apps/web/src/app/api/workers/claim/route.ts',
      'apps/web/src/app/api/tasks/route.ts',
      'apps/web/src/app/api/github/webhook/route.ts',
      'apps/web/src/app/api/mcp/route.ts',
      'packages/core/mcp-tools.ts',
    ]) expect(moduleOf(f), f).toBe('core');
    expect(moduleOf('apps/web/src/lib/subscriptions.ts')).toBe('notifications');
    expect(moduleOf('apps/web/src/lib/path-claim-release.ts')).toBe('core');
    expect(moduleOf('apps/web/src/lib/credential-health.ts')).toBe('core');
  });

  test('the scan finds the hot spot it exists to shrink', () => {
    expect(Object.keys(current.backend['apps/web/src/app/api/workers/[id]/route.ts'] ?? {}).length).toBeGreaterThan(10);
    expect(pairs(current, 'backend').length).toBeGreaterThan(100);
    expect(pairs(current, 'ui').length).toBeGreaterThan(50);
  });
});

describe('scanner mechanics', () => {
  test('type-only imports do not count; static, re-export, side-effect and dynamic imports do', () => {
    const src = [
      `import type { A } from '@/lib/mission-a';`,
      `import { b } from '@/lib/mission-b';`,
      `export { c } from './mission-c';`,
      `import '@/lib/mission-d';`,
      `const e = await import('@/lib/mission-e');`,
    ].join('\n');
    expect(runtimeSpecifiers(src)).toEqual(['@/lib/mission-b', './mission-c', '@/lib/mission-d', '@/lib/mission-e']);
  });

  test('resolves the aliases the app uses', () => {
    const files = new Set(['apps/web/src/lib/x.ts', 'packages/core/index.ts', 'packages/core/db/index.ts', 'packages/shared/src/types.ts']);
    expect(resolveSpecifier('@/lib/x', 'apps/web/src/a.ts', files)).toBe('apps/web/src/lib/x.ts');
    expect(resolveSpecifier('./lib/x.js', 'apps/web/src/a.ts', files)).toBe('apps/web/src/lib/x.ts');
    expect(resolveSpecifier('@buildd/core', 'apps/web/src/a.ts', files)).toBe('packages/core/index.ts');
    expect(resolveSpecifier('@buildd/core/db', 'apps/web/src/a.ts', files)).toBe('packages/core/db/index.ts');
    expect(resolveSpecifier('@buildd/shared/types', 'apps/web/src/a.ts', files)).toBe('packages/shared/src/types.ts');
    expect(resolveSpecifier('drizzle-orm', 'apps/web/src/a.ts', files)).toBeNull();
  });

  test('prune only removes', () => {
    const base: Baseline = { backend: { a: { m1: 'missions', m2: 'missions' } }, ui: {} };
    const now: Baseline = { backend: { a: { m1: 'missions' }, b: { m3: 'chat' } }, ui: {} };
    expect(prune(base, now)).toEqual({ backend: { a: { m1: 'missions' } }, ui: {} });
  });
});
