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
    const task = code(read(join(TASK_DIR, 'page.tsx')));
    matches(task, /parseMissionOriginParams\(\{ from, initiativeId \}\)/);
    matches(task, /missionTaskHref\(\{[^}]*\.\.\.missionBack/);
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

describe('the mission page, r5: the header, the bar, the Build stage, the stages and the decision card', () => {
  const overview = () => code(read(join(MISSION_DIR, 'MissionOverview.tsx')));
  const menu = () => code(read(join(MISSION_DIR, 'MissionOverflowMenu.tsx')));
  const page = () => code(read(join(MISSION_DIR, 'page.tsx')));

  it('R-3: one ⋯ menu with History, Flow, Re-check and Pause; no header Ask link, legend or right rail', () => {
    const m = menu();
    for (const id of ['mission-menu-history', 'mission-menu-flow', 'mission-menu-recheck', 'mission-menu-pause']) matches(m, id);
    expect(page()).not.toMatch(/AskAboutLink/);
    const o = overview();
    expect(o).not.toMatch(/overview-rail|overview-counts|<Legend\b/);
    // One spec line, `Spec <name>`, from the shared line component.
    matches(o, /<OutcomeSpecLines\b/);
  });

  it('R-3: the goal is one sentence, with an Owner goal: line read as the goal', async () => {
    const { missionSummaryLine } = await import('../../src/lib/mission-summary-line');
    expect(missionSummaryLine('Owner goal: a person deploys the cloud runner with one button. Then more.')).toBe('A person deploys the cloud runner with one button.');
  });

  it('R-4: the bar names each cell by task and state with no tick numbers, and draws the person and failed looks', async () => {
    matches(overview(), /ticks=\{false\}/);
    const { stripLook } = await import('../../src/components/ui/TaskStrip');
    expect(stripLook('needs_you')).toBe('person');
    expect(stripLook('failed')).toBe('failed');
    expect(stripLook('fixing', false)).toBe('waiting');
    const css = read(join(SRC, 'app/globals.css'));
    matches(css, /\.state-cell\[data-look="person"\]/);
    matches(css, /\.state-cell\[data-look="failed"\]/);
  });

  it('AC-4: the building mission reads 11 of 16 merged with the decision first and no task number', async () => {
    const { missionDetailCompactFixture } = await import('../../src/app/app/dev/fixtures/mission-detail-compact-fixtures');
    const { buildStage } = await import('../../src/lib/mission-build-stage');
    const f = missionDetailCompactFixture('building', null, Date.UTC(2026, 9, 22, 12));
    const stage = buildStage(f.model, f.model.now, { hrefFor: id => `/app/tasks/${id}` });
    expect(stage.summary).toBe('11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting');
    expect(stage.rows.map(r => r.state)).toEqual(['decision', 'running', 'fixing', 'waiting', 'queued']);
    for (const r of stage.rows) expect(r.title).not.toMatch(/^\d/);
    expect(f.decisions).toHaveLength(1);
    expect(f.decisions[0].task?.title).toBe('Mirror the runner image to Docker Hub');
    // The page draws these through one component that renders only the current stage.
    matches(overview(), /data-stage=\{stage\}/);
    matches(overview(), /<MissionBuildStage\b/);
  });

  it('AC-8: an open owner decision raises History above the list, named', async () => {
    const { historyRaised } = await import('../../src/lib/mission-decisions');
    const { missionDetailCompactFixture } = await import('../../src/app/app/dev/fixtures/mission-detail-compact-fixtures');
    const f = missionDetailCompactFixture('eleven', null);
    expect(historyRaised(f.model, [{ type: 'question', status: 'open', title: 'Keep the legacy export?' }])).toEqual({ kind: 'decision', text: 'Decision open: Keep the legacy export?', taskId: null, noteId: null });
    matches(overview(), /mission-history-raised/);
  });

  it('AC-9: one build-complete predicate for the Overview, explain and the card; the fold reads N tasks merged; Deliver names the branch it merged into', async () => {
    const { isBuildComplete } = await import('../../src/lib/mission-checks');
    const { buildFoldLine } = await import('../../src/lib/mission-build-stage');
    expect(isBuildComplete({ done: 16, total: 16 })).toBe(true);
    expect(isBuildComplete({ done: 15, total: 16 })).toBe(false);
    expect(buildFoldLine(16)).toBe('16 tasks merged ›');
    for (const rel of ['lib/explain.ts', 'lib/mission-card-view.ts', 'app/app/(protected)/missions/[id]/MissionOverview.tsx']) {
      matches(code(read(join(SRC, rel))), /\bisBuildComplete\(/);
    }
    // The catalog retires "delivered" as a state word (terms.ts BANNED_WORDS), so the line is the catalog's Done plus the branch.
    matches(overview(), /mission-delivered-line/);
    matches(overview(), /termWord\('mission\.done'\)/);
    matches(overview(), /merged into \$\{/);
    for (const [, text] of sources(SRC)) expect(code(text)).not.toMatch(/progress\s*>=\s*100,?\s*\n?\s*\}\)/);
  });

  it('AC-10: the mission page and Home render the one decision card, with what waits on it, each option\u2019s effect, Answer differently and Not now', async () => {
    const shared = /from ['"]@\/components\/DecisionCard['"]/;
    matches(overview(), shared);
    matches(code(read(join(SRC, 'app/app/(protected)/home/NeedsYouCards.tsx'))), shared);
    const card = code(read(join(SRC, 'components/DecisionCard.tsx')));
    matches(card, 'Answer differently');
    matches(card, 'Not now');
    const { decisionFromQuestion } = await import('../../src/lib/needs-you-card');
    const v = decisionFromQuestion({
      key: 'k', question: { headline: 'How should Docker Hub credentials be set up?', body: null, noteId: null, options: [{ label: 'Provide a token', description: 'Stored as a team secret', recommended: true }, { label: "I'll set them myself", description: 'Resumes when CI sees them', recommended: false }] },
      task: { id: 't', title: 'Mirror the runner image', href: '/app/tasks/t' }, askedAt: null, dependents: ['The release publishes an image digest'],
      answer: { kind: 'worker', workerId: 'w', taskId: 't', noteId: null },
    });
    expect(v.summary).toBe('The release publishes an image digest waits on this.');
    expect(v.options.map(o => o.effect)).toEqual(['Stored as a team secret', 'Resumes when CI sees them']);
  });

  it('AC-14: a held task reads Queued with its age, never Running or Next in line; a retry waiting on a schedule reads Fixing · resumes', async () => {
    const { missionDetailCompactFixture } = await import('../../src/app/app/dev/fixtures/mission-detail-compact-fixtures');
    const { buildStage } = await import('../../src/lib/mission-build-stage');
    const f = missionDetailCompactFixture('building', null, Date.UTC(2026, 9, 22, 12));
    const rows = buildStage(f.model, f.model.now, { hrefFor: id => id, clock: ts => new Date(ts).toISOString().slice(11, 16) }).rows;
    const queued = rows.find(r => r.state === 'queued')!;
    expect(queued.line).toMatch(/^Queued \d+[mhd]/);
    expect(queued.line).not.toMatch(/Running|Next in line/);
    expect(rows.find(r => r.state === 'fixing')!.line).toMatch(/^Fixing · CI failed · resumes \d\d:\d\d$/);
  });

  it('AC-14: a task held behind another\u2019s migration and a task no online runner can claim read Queued <age> · <hold> naming the cause, and a retry on a schedule reads Fixing · resumes <time>', async () => {
    const { buildMissionBoard } = await import('../../src/lib/mission-board');
    const { combineGateFacts, missionHoldCauses } = await import('../../src/lib/mission-board-waiting');
    const { holderFacts } = await import('../../src/lib/mission-task-hold');
    const { buildStage } = await import('../../src/lib/mission-build-stage');
    const T0 = Date.UTC(2026, 9, 22, 12);
    const NOW = T0 + 120 * 60_000;
    const min = (n: number) => T0 + n * 60_000;
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const w = (over: Record<string, unknown>) => ({
      id: `w-${Math.random().toString(36).slice(2, 8)}`, status: 'completed', runner: 'atlas', startedAt: min(1), completedAt: min(8), updatedAt: min(8),
      mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null, milestones: [], linesAdded: null, linesRemoved: null, ...over,
    }) as any;
    const t = (n: number, title: string, over: Record<string, unknown> = {}) => {
      const workers = (over.workers as any[]) ?? [];
      const wk = workers[0];
      return {
        id: id(n), title, status: 'pending', taskClass: 'work', createdAt: new Date(T0 + n * 1000), missionPhaseIndex: 1, missionPhaseLabel: 'Build',
        roleSlug: 'builder', outputRequirement: 'pr_required', workers,
        worker: wk ? { status: wk.status, startedAt: wk.startedAt ? new Date(wk.startedAt) : null, updatedAt: wk.updatedAt ? new Date(wk.updatedAt) : null, prNumber: wk.prNumber, prUrl: wk.prUrl, prLifecycleStatus: wk.prLifecycleStatus, mergedAt: null } : null,
        ...over,
      } as any;
    };
    const [HOLDER, LANE, NORUNNER, RETRY] = [30, 31, 32, 33];
    const tasks = [
      t(HOLDER, 'Add the billing column', { status: 'in_progress', workers: [w({ status: 'running', startedAt: min(100), completedAt: null, updatedAt: min(119) })] }),
      t(LANE, 'Backfill the billing column', { createdAt: new Date(NOW - 60 * 60_000) }),
      t(NORUNNER, 'Document the billing column', { createdAt: new Date(NOW - 60 * 60_000) }),
      t(RETRY, 'Settings shows each deploy step', {
        startAt: min(120 + 232),
        workers: [w({ startedAt: min(60), completedAt: min(70), updatedAt: min(70), prNumber: 450, prUrl: 'https://example.test/pull/450', prLifecycleStatus: 'ci_failed' })],
      }),
    ];
    const facts = combineGateFacts({
      edges: [], pending: [LANE, NORUNNER].map(n => ({ id: id(n), deferred: false, held: false })), deferrals: [],
      mission: { held: false, local: false, budgetExhausted: false },
      queueWaits: new Map<string, any>([[id(LANE), { kind: 'lane', lane: 'migration', holderTaskId: id(HOLDER) }], [id(NORUNNER), { kind: 'slot' }]]),
    });
    const holders = new Map([[id(HOLDER), holderFacts({ id: id(HOLDER), title: 'Add the billing column', status: 'in_progress' })]]);
    const holds = missionHoldCauses(facts, { now: NOW, runnerOnline: false, holders });
    const model = buildMissionBoard({ tasks, now: NOW, missionCreatedAt: T0, missionStatus: 'active', roles: [{ slug: 'builder', name: 'Builder', color: 'var(--c)' }], gateFacts: { ...facts, holds } } as any);
    const clock = (ts: number) => new Date(ts).toISOString().slice(11, 16);
    const rows = buildStage(model, NOW, { hrefFor: x => x, clock }).rows;
    const line = (n: number) => rows.find(r => r.id === id(n))!.line;
    expect(line(LANE)).toBe('Queued 1h · in the schema lane: runs after Add the billing column');
    expect(line(NORUNNER)).toBe('Queued 1h · no runner can take it: none is online');
    expect(line(LANE) + line(NORUNNER)).not.toMatch(/Running|Next in line/);
    expect(line(RETRY)).toMatch(/^Fixing · .*resumes \d\d:\d\d$/);
  });

  it('R-5: the Waiting on <name> group row is a toggle (aria-expanded) that lists its member rows once open', () => {
    const src = code(read(join(MISSION_DIR, 'MissionBuildStage.tsx')));
    matches(src, /data-testid="mission-waiting-group-toggle"/);
    matches(src, /aria-expanded=\{open\}/);
    matches(src, /\{open && <ul data-testid="mission-waiting-group-list"[^>]*>\{members\.map\(r => <Row key=\{r\.id\} row=\{r\} \/>\)\}<\/ul>\}/);
  });

  it('AC-18: the summary ends finish depends on <first>, then <second> → <third> when the whole path is estimated, Flow names the same first task, and one missing estimate drops the clause', async () => {
    const { dagBoard, dagId } = await import('../../src/app/app/dev/fixtures/mission-task-strip-fixtures');
    const { buildFlowTimeline, criticalPathLine, flowTaskName, missionFinishClause } = await import('../../src/lib/flow-timeline');
    const { buildStage } = await import('../../src/lib/mission-build-stage');
    const spec = { tasks: ['A', 'B', 'C'], edges: { B: ['A'], C: ['B'] }, states: { A: 'running' as const } };
    const model = dagBoard(spec);
    const [A, B, C] = spec.tasks.map(n => dagId(spec, n));
    const name = flowTaskName(model);
    const estimates = { [A]: 40, [B]: 30, [C]: 20 };
    const finish = missionFinishClause(model, model.now, estimates);
    expect(buildStage(model, model.now, { hrefFor: id => id, finish }).summary).toEndWith(`· finish depends on ${name(A)}, then ${name(B)} → ${name(C)}`);
    expect(criticalPathLine(buildFlowTimeline({ model, expectedMinutes: estimates }), s => s, name)).toStartWith(`Finish is set by ${name(A)} (`);
    const { [B]: _gone, ...missing } = estimates;
    expect(missionFinishClause(model, model.now, missing)).toBeNull();
    // The page feeds the summary the same estimates it feeds Flow.
    matches(page(), /<MissionOverview [^>]*expectedMinutes=\{flowExpectedMinutes\}/);
  });

  it('AC-11: two selected specs read 18 of 21 met, From <spec> for each, the 3 unmet with evidence and action, the all-met group one line, Standards one line, and no Run verification, Goal criteria panel or Screens row', async () => {
    const { missionDetailCompactFixture } = await import('../../src/app/app/dev/fixtures/mission-detail-compact-fixtures');
    const { missionStandardsLine } = await import('../../src/lib/mission-checks');
    const f = missionDetailCompactFixture('verify', null, Date.UTC(2026, 9, 22, 12));
    const v = f.verify!;
    expect(v.summary).toBe('18 of 21 met');
    expect(v.groups.map(g => [g.title, g.count])).toEqual([['Cloud runner: deploy from Settings', '15 of 18'], ['Settings: Runners', '3 of 3']]);
    const [big, small] = v.groups;
    expect(big.unmet.map(u => u.result)).toEqual(['Not met', "Couldn't tell", "Couldn't tell"]);
    expect(big.unmet[0].evidence.map(e => e.label)).toEqual(['Test output']);
    expect(big.unmet[0].action?.text).toMatch(/^Fixing: .+, running \d+m$/);
    expect(big.unmet[1].action?.text).toMatch(/^rechecks after .+ merges$/);
    expect(small.allMet).toBe(true);
    const standards = missionStandardsLine({ ...f.checks!, build: { done: 10, total: 10 } }, f.specTitles);
    expect(standards?.items.map(i => i.label)).toEqual(expect.arrayContaining(['CI']));
    // The page draws Verify from the view, and none of the retired controls.
    matches(page(), /<MissionOverview [^>]*verify=\{verifyView\}/);
    for (const retired of ['MissionVerifiedPill', 'MissionGoalCriteria', 'MissionScreensRow', 'CriteriaCheckNow']) expect(page()).not.toContain(retired);
    matches(overview(), /<RequirementsView\b/);
    matches(overview(), /<StandardsLineView\b/);
  });

  it('R-19: verification runs by itself on a build-completing, repair or mission PR merge; Re-check posts the evaluate route', async () => {
    const { recheckReason } = await import('../../src/lib/mission-verify-recheck');
    const build = (id: string, status: string) => ({ id, status, title: id, taskClass: 'work', context: null });
    expect(recheckReason('b', [build('a', 'completed'), build('b', 'in_progress')])).toBe('build_complete');
    expect(recheckReason('r', [build('a', 'in_progress'), { ...build('r', 'completed'), context: { specRepair: { criterionId: 'AC-1' } } }])).toBe('repair_merged');
    matches(code(read(join(SRC, 'lib/mission-subscribers.ts'))), /'recheck-criteria-on-merge'/);
    matches(menu(), /\/evaluate`/);
  });

  it('R-21: the mission column keeps the reading width through the design token', () => {
    matches(code(read(join(MISSION_DIR, 'MissionLayoutShell.tsx'))), /max-w-\[var\(--content-measure\)\]/);
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

describe('the task page', () => {
  const page = () => code(read(join(TASK_DIR, 'page.tsx')));

  it('AC-6: a running builder leads with its live block, which carries Steer, Pause and Stop', () => {
    const src = page();
    const live = src.indexOf('data-testid="task-active-worker"');
    expect(live).toBeGreaterThan(-1);
    expect(src.slice(src.lastIndexOf('<div', live), live)).toContain('order-first');
    const block = src.slice(live, src.indexOf('<TaskTimeline'));
    matches(block, '<WorkerSteerPanel');
  });

  it('AC-6: a stopped task leads with the timeline; the live block is behind Run; no mission strip or Execution Plan', () => {
    const src = page();
    matches(src, /\{!activeWorker && <TaskTimeline groups=\{timeline\} \/>\}/);
    // The stopped run's live view only renders inside a Run disclosure.
    const archived = src.indexOf('const archivedWorkerSection');
    matches(src.slice(archived, src.indexOf('</>);', archived)), '<RealTimeWorkerView');
    const uses = [...src.matchAll(/\{archivedWorkerSection\}/g)].map(m => m.index!);
    expect(uses.length).toBeGreaterThan(0);
    for (const at of uses) {
      const before = src.slice(0, at);
      const opened = Math.max(before.lastIndexOf('<TaskShippedDetails'), before.lastIndexOf('>Run</summary>'));
      expect(opened).toBeGreaterThan(Math.max(before.lastIndexOf('</TaskShippedDetails>'), before.lastIndexOf('</details>')));
    }
    expect(src.indexOf('<TaskTimeline')).toBeLessThan(src.indexOf('<TaskShippedDetails'));
    expect(src).not.toMatch(/\bMissionContextBar\b|\bPlanChainView\b/);
    expect(existsSync(join(TASK_DIR, 'MissionContextBar.tsx'))).toBe(false);
    expect(existsSync(join(TASK_DIR, 'PlanChainView.tsx'))).toBe(false);
  });
});
