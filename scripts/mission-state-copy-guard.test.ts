import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Spec 8e137fdb r4 I-17 / AC-20: a mission-state surface may not word a state
 * itself. Two rules, scoped to the mission UI so legitimate diagnostic logs
 * and API errors elsewhere are untouched:
 *
 *  1. No banned narration (generated "Nothing is running its N open tasks"
 *     style filler) in a mission surface or in the view/presentation modules.
 *  2. A mission UI component does not call a state derivation. State, cause
 *     and action come from `MissionStateView` / `presentMissionState`; a
 *     component that imports `deriveTaskHealthSignal`, `classifyMissionWait`
 *     and friends is growing a second owner. Passing `view` props down is fine.
 *
 * A failure names the file and the line, so the surface is identified.
 */
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'apps/web/src'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const isTest = (f: string) => /\.(test|fixtures?)\.tsx?$/.test(f) || f.includes('/dev/fixtures/');

const UI_SURFACES = files.filter(
  f =>
    f.endsWith('.tsx') &&
    !isTest(f) &&
    (f.startsWith('apps/web/src/components/missions/') || f.startsWith('apps/web/src/app/app/(protected)/missions/')),
);
const STATE_MODULES = [
  'apps/web/src/lib/mission-state-view.ts',
  'apps/web/src/lib/mission-state-presentation.ts',
  'apps/web/src/lib/mission-overview.ts',
  'apps/web/src/lib/mission-card-view.ts',
  'apps/web/src/lib/mission-list-card.ts',
];

const BANNED_NARRATION: Array<[RegExp, string]> = [
  [/nothing is running its/i, '"Nothing is running its N open tasks" is generated narration; say Interrupted or Waiting'],
  [/nothing is running the open task/i, 'generated narration; say Interrupted or Waiting'],
  [/\$\{[^}]*\}\s+open tasks? (are|is) running/i, 'a component-local sentence built from task counts'],
];

/** Derivations a mission UI component must not import (the page loader is the one place that runs them). */
const FORBIDDEN_IN_COMPONENTS = /\b(deriveTaskHealthSignal|classifyMissionWait|deriveMissionHealth|deriveMissionDisplayState|canCompleteMission|evaluateMissionWorkState)\b/;
/** Grandfathered: renders from a passed view but still imports a helper. Shrinks only. */
const COMPONENT_ALLOWLIST = new Set<string>(['apps/web/src/components/missions/MissionMasthead.tsx']);
const PAGE_LOADERS = /\/missions\/\[id\]\/page\.tsx$/;

function scan(list: string[], rules: Array<[RegExp, string]>): string[] {
  const hits: string[] = [];
  for (const f of list) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const [re, why] of rules) if (re.test(line)) hits.push(`${f}:${i + 1}: ${why}`);
    });
  }
  return hits;
}

describe('mission state copy guard (spec 8e137fdb I-17, AC-20)', () => {
  test('scope is non-empty', () => {
    expect(UI_SURFACES.length).toBeGreaterThan(5);
    for (const f of STATE_MODULES) expect(files).toContain(f);
  });

  test('no banned narration on a mission surface or state module', () => {
    expect(scan([...UI_SURFACES, ...STATE_MODULES], BANNED_NARRATION)).toEqual([]);
  });

  test('no mission UI component derives state itself', () => {
    const components = UI_SURFACES.filter(f => !PAGE_LOADERS.test(f) && !COMPONENT_ALLOWLIST.has(f));
    expect(scan(components, [[FORBIDDEN_IN_COMPONENTS, 'component-local state derivation: read MissionStateView / presentMissionState']])).toEqual([]);
  });

  test('the guard fires: a planted violation is reported with its file and line', () => {
    const planted = scan([], BANNED_NARRATION);
    expect(planted).toEqual([]);
    const line = 'const s = `Nothing is running its ${n} open tasks`;';
    expect(BANNED_NARRATION.some(([re]) => re.test(line))).toBe(true);
    expect(FORBIDDEN_IN_COMPONENTS.test("import { deriveTaskHealthSignal } from '@/lib/mission-helpers';")).toBe(true);
  });
});
