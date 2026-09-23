/**
 * `/api/update` and `/api/update/apply` used to diverge: only the former ran
 * the local-peer / active-worker / dirty-tree gate, and only the former
 * health-probed the new build before restarting into it. `/api/update/apply`
 * checked `updateState.updating` and nothing else, then applied the update
 * synchronously with no probe.
 *
 * index.ts has top-level side effects (env var checks, `process.exit` calls
 * on missing config) that make it unsafe to `import` in a test — see
 * public-worker.test.ts for the established pattern of asserting against its
 * source text instead. These checks pin that both route handlers now run
 * through the exact same gate (`evaluateManualUpdateGate`) and the exact same
 * orchestration (`performManualUpdate`), so they cannot silently drift apart
 * again.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(import.meta.dir, '../../src');
const index = readFileSync(join(SRC, 'index.ts'), 'utf8');

function routeBlock(src: string, path: string): string {
  const marker = `if (path === '${path}' && req.method === 'POST') {`;
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  // Walk forward to the matching close brace for this if-block.
  let depth = 0;
  let i = start + marker.length - 1; // sit on the opening '{'
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(depth).toBe(0);
  return src.slice(start, i + 1);
}

describe('/api/update and /api/update/apply route through the same gate + orchestration', () => {
  const updateRoute = routeBlock(index, '/api/update');
  const applyRoute = routeBlock(index, '/api/update/apply');

  test('both call evaluateManualUpdateGate before doing anything else', () => {
    expect(updateRoute).toMatch(/evaluateManualUpdateGate\(/);
    expect(applyRoute).toMatch(/evaluateManualUpdateGate\(/);
  });

  test('both call performManualUpdate once the gate passes', () => {
    expect(updateRoute).toMatch(/performManualUpdate\(/);
    expect(applyRoute).toMatch(/performManualUpdate\(/);
  });

  test('both pass the shared manualUpdateDeps object, not a bespoke one', () => {
    expect(updateRoute).toMatch(/performManualUpdate\([^,]+,\s*manualUpdateDeps\)/);
    expect(applyRoute).toMatch(/performManualUpdate\([^,]+,\s*manualUpdateDeps\)/);
  });

  test('neither route hand-rolls the gate checks the shared gate already covers', () => {
    for (const route of [updateRoute, applyRoute]) {
      expect(route).not.toMatch(/execSync/);
      expect(route).not.toMatch(/Cannot update while tasks are running/);
      expect(route).not.toMatch(/Working tree has uncommitted changes/);
    }
  });
});

describe('manualUpdateDeps wiring', () => {
  test('the health probe failure path is wired to rollbackTo, not a hand-rolled reset', () => {
    // performManualUpdate itself (update-gate.ts) owns the rollback-on-failed-probe
    // branching; index.ts only has to hand it a real rollbackTo. Assert the deps
    // object actually does, so a future edit can't quietly reintroduce an inline
    // `gitAsync(['reset', '--hard', ...])` rollback here instead.
    const depsBlock = /const manualUpdateDeps: ManualUpdateDeps = \{([\s\S]*?)\n\};/.exec(index);
    expect(depsBlock).not.toBeNull();
    expect(depsBlock![1]).toMatch(/rollbackTo:\s*\(targetCommit\)\s*=>\s*rollbackTo\(targetCommit\)/);
    expect(depsBlock![1]).toMatch(/applyUpdate:\s*\(\)\s*=>\s*applyUpdate\(\)/);
    expect(depsBlock![1]).toMatch(/runHealthProbe/);
    expect(depsBlock![1]).toMatch(/scheduleGracefulRestart/);
  });
});
