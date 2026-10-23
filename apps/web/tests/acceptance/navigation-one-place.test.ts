/**
 * Acceptance checks for Living Spec d25d923d "Navigation: one place per task",
 * revision 1. Written before the build: each test fails on the starting commit
 * and passes once the spec is built. A check named here is listed in the
 * spec's metadata `verified_by`, keyed by its id.
 *
 * The tests read existing seams (the link helper, the layout parser, the strip
 * progress projection) and the source tree, so they do not dictate component
 * names the build is free to choose.
 */
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyTaskSheetRedirect, missionTaskHref, taskPageHref } from '../../src/lib/mission-task-href';
import { parseMissionLayout } from '../../src/lib/mission-layout';
import { taskRowsProgress } from '../../src/lib/mission-strip-order';

const SRC = join(import.meta.dir, '..', '..', 'src');
const MISSION_DIR = join(SRC, 'app/app/(protected)/missions/[id]');
const TASK_DIR = join(SRC, 'app/app/(protected)/tasks/[id]');

const read = (path: string) => readFileSync(path, 'utf8');
const isTest = (rel: string) => /\.(test|dom\.test)\.tsx?$/.test(rel) || rel.includes('/fixtures/');

/** Every non-test source file under a directory, as [relative path, text]. */
function sources(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rel of new Glob('**/*.{ts,tsx}').scanSync({ cwd: dir })) {
    if (isTest(rel)) continue;
    out.push([rel, read(join(dir, rel))]);
  }
  return out;
}

/** Source with comments removed, so a retired name in a doc comment is not a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');


/** A short failure message: a whole source file must never end up in the test output. */
function matches(text: string, pattern: RegExp | string): void {
  const ok = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  if (!ok) throw new Error(`expected the source to contain ${String(pattern)}`);
}

const pathOf = (href: string) => new URL(href, 'http://x').pathname;

describe('one task view', () => {
  const RETIRED = [
    'app/app/(protected)/missions/[id]/TaskSheet.tsx',
    'app/app/(protected)/missions/[id]/TaskPanel.tsx',
    'app/app/(protected)/missions/[id]/TaskPanelWrapper.tsx',
  ];

  it('R-1: the sheet and dock are removed, and Overview has no focus card', () => {
    expect(RETIRED.filter(rel => existsSync(join(SRC, rel)))).toEqual([]);
    expect(code(read(join(MISSION_DIR, 'MissionOverview.tsx')))).not.toMatch(/\bFocusCard\b/);
  });

  it('AC-1: missionTaskHref opens the task page from every origin', () => {
    for (const from of [undefined, 'home', 'missions', 'initiative'] as const) {
      const href = missionTaskHref({ missionId: 'm1', taskId: 't1', from, initiativeId: 'i1' });
      expect(pathOf(href)).toBe('/app/tasks/t1');
    }
  });

  it('AC-1: the task page link keeps the mission back-link context', () => {
    const href = missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'initiative', initiativeId: 'i1' });
    const q = new URL(href, 'http://x').searchParams;
    expect(q.get('missionId')).toBe('m1');
    expect(q.get('from')).toBe('initiative');
    expect(q.get('initiativeId')).toBe('i1');
    expect(q.get('task')).toBeNull();
    expect(taskPageHref({ taskId: 't1', missionId: 'm1' })).toContain('/app/tasks/t1');
  });

  it('AC-1: nothing renders a sheet or dock role for a task', () => {
    const offenders: string[] = [];
    for (const [rel, text] of sources(SRC)) {
      const c = code(text);
      if (/from ['"][^'"]*\/(TaskSheet|TaskPanel|TaskPanelWrapper)['"]/.test(c)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('links that work today keep working', () => {
  const missionPage = () => code(read(join(MISSION_DIR, 'page.tsx')));

  const taskId = '00000000-0000-4000-8000-000000000001';

  it('R-2: /app/missions/M?task=T redirects through the compatibility helper', () => {
    const page = missionPage();
    matches(page, /\btask\??:\s*string/);
    matches(page, /legacyTaskSheetRedirect\(id, search\)/);
    matches(page, /redirect\(taskPage\)/);
    expect(pathOf(legacyTaskSheetRedirect('m1', { task: taskId })!)).toBe(`/app/tasks/${taskId}`);
  });

  it('AC-2: ?task=T&from=initiative&initiativeId=I lands on task T with a back link to M inside I', () => {
    const href = legacyTaskSheetRedirect('m1', { task: taskId, from: 'initiative', initiativeId: 'i1', respond: '1' });
    const target = new URL(href!, 'http://x');
    expect(target.pathname).toBe(`/app/tasks/${taskId}`);
    expect(target.searchParams.get('missionId')).toBe('m1');
    expect(target.searchParams.get('from')).toBe('initiative');
    expect(target.searchParams.get('initiativeId')).toBe('i1');
    expect(target.searchParams.get('respond')).toBe('1');
    // The task page draws the mission and initiative back link from these params.
    const ctx = code(read(join(TASK_DIR, 'mission-context-bar.ts')));
    matches(ctx, /initiative/i);
  });

  it('AC-3: every row of the R-2 table lands where it says', () => {
    // ?layout=board -> the mission page (Overview)
    expect(parseMissionLayout('board')).toBe('board');
    // ?layout=flow, ?view=structure, ?layout=lanes -> Flow
    expect(parseMissionLayout('flow')).toBe('flow');
    expect(parseMissionLayout(undefined, 'structure')).toBe('flow');
    expect(parseMissionLayout('lanes')).toBe('flow');
    // ?layout=feed, ?view=timeline -> History
    expect(parseMissionLayout('feed')).toBe('feed');
    expect(parseMissionLayout(undefined, 'timeline')).toBe('feed');
    // #t-T stays on the mission page: the link helper still builds the anchor.
    const focus = missionTaskHref({ missionId: 'M', taskId: 'T', mode: 'focus' });
    expect(pathOf(focus)).toBe('/app/missions/M');
    expect(new URL(focus, 'http://x').hash).toBe('#t-T');
    // ?qaHistory=1 -> History, ?visualReview=1 / ?artifact= unchanged
    const page = missionPage();
    matches(page, /qaHistory/);
    matches(page, /visualReview/);
    matches(page, /artifact/);
    // ?task=T -> the task page (the one row that changes)
    matches(page, /redirect\(/);
    expect(pathOf(legacyTaskSheetRedirect('m1', { task: taskId })!)).toBe(`/app/tasks/${taskId}`);
  });
});

describe('the mission page', () => {
  it('R-3: has no tab bar', () => {
    const offenders: string[] = [];
    for (const [rel, text] of sources(MISSION_DIR)) {
      if (/role=["']tablist["']/.test(code(text)) || /<MissionLayoutTabs\b/.test(code(text))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('R-3: ends in a History link', () => {
    const page = code(read(join(MISSION_DIR, 'page.tsx')) + sources(MISSION_DIR).map(([, t]) => t).join('\n'));
    matches(page, /layout=feed|layout: ['"]feed['"]|missionLayoutHref\([^)]*['"]feed['"]\)/);
  });
});

describe('the bar', () => {
  it('R-4: merged is solid, running is a drifting hatch, waiting is dashed, and the drift ignores reduced motion', () => {
    const css = read(join(SRC, 'app/globals.css'));
    const hatchKeyframes = css.match(/@keyframes\s+([\w-]*hatch[\w-]*)/)?.[1];
    expect(hatchKeyframes).toBeDefined();
    // No reduced-motion block may switch that animation off.
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g) ?? [];
    for (const block of reduced) {
      const hit = block.split('}').filter(rule => rule.includes(hatchKeyframes!) || /bar-hatch|hatch/.test(rule));
      expect(hit.filter(rule => /animation(-name)?:\s*none/.test(rule))).toEqual([]);
    }
  });
});

describe('helper runs are not tasks and not bar cells', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const row = (i: number, title: string, status: string, over: Record<string, unknown> = {}) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    return {
      id, title, status, taskClass: 'work', mode: 'execution', kind: 'engineering', roleSlug: 'builder',
      outputRequirement: 'none', createdAt: new Date(T0 + i), updatedAt: new Date(T0 + i), dependsOn: [],
      workers: [{
        id: `w-${i}`, taskId: id, status: 'running', startedAt: new Date(T0 + i), createdAt: new Date(T0 + i),
        updatedAt: new Date(T0 + i + 1), completedAt: null, mergedAt: null, prUrl: null, prNumber: null, prLifecycleStatus: null,
      }],
      ...over,
    };
  };

  it('AC-5: a running surface audit and two criterion checks add no bar cell', () => {
    const rows = [
      row(1, 'feat: build the thing', 'in_progress'),
      row(2, '[surface audit] Mission', 'in_progress', { roleSlug: 'visual-auditor' }),
      row(3, 'Check spec criterion R-1', 'in_progress', { context: { finalVerification: { criterionId: 'R-1' } } }),
      row(4, 'Check spec criterion R-2', 'in_progress', { context: { finalVerification: { criterionId: 'R-2' } } }),
    ];
    expect(taskRowsProgress(rows as never)).toHaveLength(1);
  });

  it('R-12: final verification and acceptance-test tasks are not bar cells either', () => {
    const rows = [
      row(1, 'feat: build', 'in_progress'),
      row(2, '[final verification] Mission', 'in_progress', { context: { finalVerification: {} } }),
      row(3, '[acceptance tests] Spec', 'in_progress', { context: { acceptanceTests: {} } }),
    ];
    expect(taskRowsProgress(rows as never)).toHaveLength(1);
  });

  it('R-11: a reviewer round and a fix attempt are events in the parent task\'s Verify group, worded as the spec words them', () => {
    const all = sources(SRC).map(([, text]) => code(text)).join('\n');
    // `Code review · Changes requested · round 1`, `Fix 1 · CI passed`
    matches(all, /Code review · [^\n]*round/);
    matches(all, /[`'"]Fix \$\{|[`'"]Fix \d+ · /);
  });
});

describe('Home and the Agents list', () => {
  it('R-13: Home rows open the task page directly (no mission sheet mode)', () => {
    const offenders: string[] = [];
    for (const [rel, text] of sources(join(SRC, 'app/app/(protected)/home'))) {
      if (/mode:\s*['"]sheet['"]/.test(code(text))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    for (const [rel, text] of sources(SRC)) {
      if (/\btask=\$\{|[?&]task=['"`]/.test(code(text)) && /\/app\/missions\//.test(code(text))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('words', () => {
  it('R-14: a task state reads Approval required, and a failed task with a retry waiting reads Retry in … with Retry now', () => {
    const all = sources(SRC).map(([, text]) => code(text)).join('\n');
    matches(all, 'Approval required');
    matches(all, /Retry in /);
    matches(all, 'Retry now');
  });
});
