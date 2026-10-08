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

describe('seams that have shipped stay cut', () => {
  // The worker PATCH's post-commit fan-out moved behind emit() (lib/core-emit.ts):
  // core emits, the composition root (apps/web/src/modules.ts) lists who reacts.
  const PATCH = 'apps/web/src/app/api/workers/[id]/route.ts';
  const movedBehindEmit = [
    'apps/web/src/lib/subscriptions.ts',
    'apps/web/src/lib/task-evidence-store.ts',
    'apps/web/src/lib/mission-completion.ts',
    'apps/web/src/lib/mission-criteria-verify.ts',
    'apps/web/src/lib/mission-criteria-prose.ts',
    'apps/web/src/lib/mission-criteria-worker-eval.ts',
    'apps/web/src/lib/subject-sweep.ts',
    'apps/web/src/lib/memory-decisions.ts',
    'apps/web/src/lib/notify-rules.ts',
  ];

  test('the worker PATCH no longer imports the modules its completion fans out to', () => {
    const imported = Object.keys(current.backend[PATCH] ?? {});
    expect(imported.filter(f => movedBehindEmit.includes(f))).toEqual([]);
  });

  test('task and team creation no longer import what their creation sets off', () => {
    const behindTaskCreated = [
      'apps/web/src/lib/mission-feed.ts',
      'apps/web/src/lib/mission-loop.ts',
      'apps/web/src/lib/criteria-escalation.ts',
      'apps/web/src/lib/task-category-decision.ts',
    ];
    const tasksRoute = Object.keys(current.backend['apps/web/src/app/api/tasks/route.ts'] ?? {});
    expect(tasksRoute.filter(f => behindTaskCreated.includes(f))).toEqual([]);
    for (const f of ['apps/web/src/auth.ts', 'apps/web/src/app/api/teams/route.ts']) {
      expect(Object.keys(current.backend[f] ?? {}), f).not.toContain('apps/web/src/lib/default-roles.ts');
    }
  });

  test('the worker PATCH reaches the loop, evidence and release verdicts only through completion-policy slots', () => {
    const behindSlots = [
      'apps/web/src/lib/loop-dispatcher.ts',
      'apps/web/src/lib/visual-audit-evidence.ts',
      'apps/web/src/lib/release-executor.ts',
      'apps/web/src/lib/mission-release.ts',
    ];
    const imported = Object.keys(current.backend[PATCH] ?? {});
    expect(imported.filter(f => behindSlots.includes(f))).toEqual([]);
  });

  test('the GitHub webhook reaches the releases module only through emit()', () => {
    const imported = Object.entries(current.backend['apps/web/src/app/api/github/webhook/route.ts'] ?? {});
    expect(imported.filter(([, mod]) => mod === 'releases').map(([f]) => f)).toEqual([]);
  });

  test('the GitHub webhook keeps only the mission base guard from the missions module', () => {
    // The guard repairs a task PR's base when it leaves the mission integration
    // branch: a review-gate enforcement, so it stays in core (design: module
    // gates move into core intact). Every other mission reaction is a subscriber.
    const imported = Object.entries(current.backend['apps/web/src/app/api/github/webhook/route.ts'] ?? {});
    expect(imported.filter(([, mod]) => mod === 'missions').map(([f]) => f).sort()).toEqual([
      'apps/web/src/lib/mission-base-guard.ts',
      'packages/core/mission-integration.ts',
    ]);
  });

  test('the GitHub webhook reaches the review reactions to a PR closing and to a GitHub review only through emit()', () => {
    // Verdict flows: review capture and the GitHub verdict note, the merge-vs-
    // verdict telemetry, supersession detection and reconcile, dead-PR
    // shutdown, and the on-close activity comment and review callback.
    const imported = Object.keys(current.backend['apps/web/src/app/api/github/webhook/route.ts'] ?? {});
    expect(imported.filter(f => [
      'apps/web/src/lib/review-feedback.ts',
      'apps/web/src/lib/supersession.ts',
      'apps/web/src/lib/pr-supersession-detect.ts',
      'apps/web/src/lib/dead-pr-shutdown.ts',
    ].includes(f))).toEqual([]);
  });

  test('the GitHub webhook reaches reviewer dispatch, re-review and the CI-fix retry only through emit() and the PR-opened slot', () => {
    // What is left is core: landing, auto-merge safety, the merge-policy chain,
    // the verdict reads the check_suite merge door and the release door gate
    // on, and the PR's claim-scope reconcile.
    const imported = Object.entries(current.backend['apps/web/src/app/api/github/webhook/route.ts'] ?? {});
    expect(imported.filter(([, mod]) => mod === 'reviews-merge').map(([f]) => f).sort()).toEqual([
      'apps/web/src/lib/auto-merge.ts',
      'apps/web/src/lib/merge-policy.ts',
      'apps/web/src/lib/pr-landing.ts',
      'apps/web/src/lib/pr-review-request.ts',
      'apps/web/src/lib/pr-review-status.ts',
      'apps/web/src/lib/pr-scope-reconcile-trigger.ts',
      'apps/web/src/lib/review-verdict-gate.ts',
    ]);
    expect(imported.map(([f]) => f)).not.toContain('apps/web/src/lib/migration-inspector.ts');
  });

  test('no core file writes the subscriptions ledger directly; it is a notifications subscriber', () => {
    const writers = pairs(current, 'backend').filter(p => p.endsWith('-> apps/web/src/lib/subscriptions.ts'));
    expect(writers).toEqual([]);
  });

  test('the composition root is the only exempt importer', () => {
    expect([...COMPOSITION_ROOTS]).toEqual(['apps/web/src/modules.ts']);
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
    // Trace parsing and task-page error presentation belong to the core run record,
    // rather than the knowledge retrieval or health analytics modules.
    expect(moduleOf('packages/core/bash-failure-trace.ts')).toBe('core');
    expect(moduleOf('apps/web/src/app/app/(protected)/tasks/[id]/error-evidence.ts')).toBe('core');
    // Ops paging is core infrastructure every layer uses, not the health module.
    expect(moduleOf('packages/core/report-ops.ts')).toBe('core');
    expect(moduleOf('apps/web/src/app/api/cron/maintenance/route.ts')).toBe('core');
    // The hosted-runner allowance gates the claim, so its store is core; usage analytics is not.
    expect(moduleOf('apps/web/src/lib/hosted-runner-usage-store.ts')).toBe('core');
    expect(moduleOf('apps/web/src/lib/usage-stats.ts')).toBe('health-quality');
    // The question gate is core; the repair filer it recovers through is a decisions module behind a slot.
    expect(moduleOf('apps/web/src/lib/question-gate-check.ts')).toBe('core');
    expect(moduleOf('apps/web/src/lib/recoverable-blocker-repair.ts')).toBe('jev-decisions');
    // An agent's brokered decide call is a Jev decision, reached by its own route, not by core.
    expect(moduleOf('apps/web/src/lib/capability-model-inference.ts')).toBe('jev-decisions');
    expect(moduleOf('apps/web/src/app/api/agent-capabilities/model-inference/route.ts')).toBe('jev-decisions');
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
