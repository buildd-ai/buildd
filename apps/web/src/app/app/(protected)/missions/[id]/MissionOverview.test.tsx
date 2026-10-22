/**
 * The Overview: the lg strip with the finish-setting task selected, its focus
 * card, and the right rail. Static markup from the strip fixtures.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionOverview, FocusStatus } = await import('./MissionOverview');
const { railLines, overviewLayout } = await import('@/lib/mission-overview');
const { dagBoard, dagId, DAG_SPECS, overviewWavesBoard } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');
const countsText = (markup: string) => markup.match(/data-testid="overview-counts"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;

const spec = DAG_SPECS.linear;
const html = renderToStaticMarkup(<MissionOverview model={dagBoard(spec)} missionId="mission-1" workspaceId="ws-1" />);

const compact = await import('@/app/app/dev/fixtures/mission-detail-compact-fixtures');

describe('MissionOverview', () => {
  it('opens on the task in flight, not the first task', () => {
    const selected = html.match(/data-id="([^"]+)"[^>]*aria-pressed="true"/)?.[1];
    expect(selected).toBe(dagId(spec, 'B'));
  });

  it('draws the lg strip, a focus card and the counts', () => {
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('data-testid="focus-card"');
    expect(countsText(html)).toBe('1 of 5 merged');
    // No legend row of states: each cell's state is named on its card.
    expect(html).not.toContain('data-legend=');
    expect(html).toContain('data-testid="overview-stepper"');
  });

  it('puts the agents and needs-you counts in the rail, capped to a 720px main column', () => {
    expect(html).toContain('data-testid="overview-rail"');
    expect(html).toContain('data-testid="rail-needs"');
    expect(html).toContain('min-[900px]:grid-cols-[minmax(0,720px)');
  });

  // Owner report: "Agents live 1 / Needs you 0" is label-speak. Counts read as words.
  it('says the counts in words, not label and number', () => {
    const rail = html.slice(html.indexOf('data-testid="overview-counts-rail"'));
    expect(rail).not.toMatch(/Agents live|Needs you|waiting on you/);
    expect(railLines(0, 0)).toEqual({ agents: 'No agents working', needs: 'Nothing to decide' });
    expect(railLines(1, 1)).toEqual({ agents: '1 agent working', needs: '1 decision to make' });
    expect(railLines(3, 2)).toEqual({ agents: '3 agents working', needs: '2 decisions to make' });
  });

  it('names the selection once: "02 of 05" in the card, the stepper keeps only the state', () => {
    expect(html).toContain('02 of 05');
    const stepper = html.slice(html.indexOf('data-testid="overview-stepper"'));
    expect(stepper).not.toMatch(/\d\d of \d\d/);
  });
});

describe('MissionOverview, 11 tasks with delivery', () => {
  const f = compact.missionDetailCompactFixture('eleven', null);
  const out = renderToStaticMarkup(<MissionOverview model={f.model} deliveries={f.deliveries} missionId="mission-1" workspaceId="ws-1" />);

  it('draws Build › Verify › Deliver once (the Lifecycle line), not a second stage grid', () => {
    expect(out.match(/data-testid="lifecycle"/g)).toHaveLength(1);
    expect(out).not.toContain('data-testid="delivery-stages"');
  });

  it('the counts line is build counts only; criteria live in the Verified pill and the rail', () => {
    const counts = countsText(out)!;
    expect(counts).toMatch(/^3 of \d+ merged$/);
    expect(counts).not.toMatch(/criteri/);
  });
});

// Spec f7f67f1a R-1, R-3, R-5, R-6 (revision 6).
describe('MissionOverview groups', () => {
  const model = overviewWavesBoard(20);
  const layout = overviewLayout(model);
  const out = renderToStaticMarkup(<MissionOverview model={model} missionId="mission-1" workspaceId="ws-1" />);
  const cellIds = [...out.matchAll(/<button[^>]*data-id="([^"]+)"/g)].map(m => m[1]);

  it('draws cells Done first, then In progress, Waiting and checks, so the keys step in that order', () => {
    expect(cellIds).toEqual(layout.order);
  });

  it('outlines only the In progress group, exactly over its columns', () => {
    const outlines = [...out.matchAll(/data-testid="task-strip-group-outline"[^>]*data-group="([^"]+)"[^>]*style="grid-column:([^;"]+)/g)];
    expect(outlines.map(o => o[1])).toEqual(['active']);
    const active = layout.groups.find(g => g.key === 'active')!.ids;
    const col = (id: string) => Number(out.match(new RegExp(`data-id="${id}"[^>]*style="grid-column:(\\d+)`))?.[1]);
    const [from, to] = outlines[0][2].split('/').map(Number);
    expect(from).toBe(col(active[0]));
    expect(to).toBe(col(active[active.length - 1]) + 1);
  });

  it('marks each waiting cell with its cause, and names it', () => {
    expect(out).toContain('data-wait="tasks"');
    expect(out).toContain('data-wait="slot"');
    expect(out).toContain('data-wait="hold"');
    expect(out).toMatch(/aria-label="\d\d Next in line: /);
    // A hold names its cause (terms catalog); with no cause known it reads Waiting, never Held.
    expect(out).toMatch(/aria-label="\d\d Waiting: /);
    expect(out).not.toMatch(/aria-label="\d\d Held: /);
  });

  it('counts merged build work only, never a row of states', () => {
    expect(countsText(out)).toBe('10 of 20 merged');
    expect(out).not.toContain('data-legend=');
  });

  it('a two-task mission draws two compact cells, not two wide slabs', () => {
    const two = renderToStaticMarkup(<MissionOverview model={overviewWavesBoard(2)} missionId="mission-1" workspaceId="ws-1" />);
    expect(two).toContain('md:[--cell:minmax(0,56px)]');
    expect(two.match(/<button[^>]*data-id=/g)).toHaveLength(2);
  });
});

const { handoffFixture } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');

describe('MissionOverview handoff (spec f7f67f1a R-11 to R-24)', () => {
  const base = { now: Date.UTC(2026, 9, 14, 12), missionCreatedAt: Date.UTC(2026, 9, 14, 11), missionStatus: 'active' as const };
  const render = (variant: Parameters<typeof handoffFixture>[0]) => {
    const f = handoffFixture(variant, base);
    return renderToStaticMarkup(
      <MissionOverview model={f.model} missionId="mission-1" workspaceId="ws-1" executor={f.executor} checks={f.checks} planTasks={f.planTasks} held={f.held} />,
    );
  };
  const rows = (markup: string) => [...markup.matchAll(/data-testid="mission-check" data-kind="([^"]+)" data-status="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);
  const rail = (markup: string) => [...markup.matchAll(/data-step="([^"]+)" data-state="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);

  it('while building: the strip and counts stay, Build is the checkpoint, and the estimate says build only', () => {
    const html = render('handoff-building');
    expect(html).toContain('data-testid="task-strip"');
    expect(html).not.toContain('data-testid="build-complete-bar"');
    expect(rail(html)).toEqual(['build:now', 'verify:todo', 'deliver:todo']);
    expect(html).toMatch(/data-testid="overview-estimate"[^>]*>build only: /);
  });

  it('build done: the strip folds into Build complete and the checks take the focus, with no overall done claim', () => {
    const html = render('handoff-verifying');
    expect(html).toContain('data-testid="build-complete-bar"');
    expect(html).toContain('Build complete');
    expect(html).toContain('Show tasks');
    expect(html).not.toContain('data-testid="task-strip"');
    expect(html).not.toContain('data-testid="overview-counts"');
    expect(rows(html)).toEqual(['visual:running', 'mission_pr:queued', 'criterion:queued', 'release:queued']);
    expect(rail(html)).toEqual(['build:done', 'verify:now', 'deliver:todo']);
    expect(html).not.toMatch(/Delivered|%/);
  });

  it('a visual finding shows its fix inside the check, and the fix is not in the build count', () => {
    const html = render('handoff-repairing');
    expect(rows(html)[0]).toBe('visual:finding');
    expect(html).toContain('data-testid="mission-check-repairs"');
    expect(html).toContain('filter selection resets after a refresh');
    expect(html).toContain('10 of 10 in the mission branch');
  });

  it('reviewer merge shows no owner button; human merge names the owner but adds no Approve or Merge button here', () => {
    const reviewer = render('handoff-reviewer');
    expect(reviewer).toContain('reviewer deciding');
    const human = render('handoff-approval');
    expect(human).toContain('approve to deliver');
    const checksAndRail = human.slice(0, human.indexOf('data-testid="overview-rail"'));
    expect(checksAndRail).not.toMatch(/your merge|your call|waiting on you/);
    // The rail agrees with the check: one decision waits on the owner.
    expect(human).toMatch(/data-testid="rail-needs" data-count="1"/);
    expect(reviewer).toMatch(/data-testid="rail-needs" data-count="0"/);
    for (const html of [reviewer, human]) {
      const card = html.slice(html.indexOf('data-testid="mission-checks"'));
      expect(card).not.toMatch(/<button[^>]*>(Approve|Merge)[^<]*<\/button>/);
    }
  });

  it('a failed deploy never reads delivered; a healthy one does', () => {
    expect(rail(render('handoff-deploy-failed'))).toEqual(['build:done', 'verify:done', 'deliver:held']);
    const healthy = render('handoff-delivered');
    expect(rail(healthy)).toEqual(['build:done', 'verify:done', 'deliver:done']);
    expect(healthy).toContain('released, healthy');
  });

  it('the build-only estimate is the Plan page\u2019s schedule for the same build tasks', async () => {
    const { planMissions } = await import('@/lib/mission-plan');
    const { buildEstimate } = await import('@/lib/mission-checks');
    const f = handoffFixture('handoff-building', base);
    const [plan] = planMissions([{ id: 'm', title: 'M', href: '', workspaceId: null, blocked: null, dependsOnMissionId: null, tasks: f.planTasks! }], base.now);
    const ours = buildEstimate(f.planTasks!, base.now, false)!;
    expect([ours.p50, ours.p80]).toEqual([plan.p50!, plan.p80!]);
  });

  it('a budget hold removes the time promise', () => {
    expect(render('handoff-budget')).not.toContain('data-testid="overview-estimate"');
  });
});

// mission-feed §Status vocabulary: one dot, one word, one short cause; no Next sentence.
describe('MissionOverview focus status line', () => {
  const model = dagBoard(spec);
  const running = dagId(spec, 'B');
  const status = (markup: string) => markup.match(/data-testid="focus-status" data-word="([^"]+)"/)?.[1] ?? null;

  it('the running task reads Working with a ticking clock, and the flow is one line', () => {
    expect(status(html)).toBe('Working');
    expect(html).toMatch(/data-testid="focus-status-word"[^>]*>Working \d/);
    expect(html).toContain('data-variant="line"');
    expect(html).not.toContain('>Next</dt>');
  });

  it('Est. and its bar appear only with a frozen estimate the page loaded', () => {
    expect(html).not.toContain('data-testid="focus-estimate"');
    const plan = [{ id: running, status: 'in_progress', dependsOn: [], startedAt: model.tasks[running].startedAt, endedAt: null, p50Minutes: 40, p80Minutes: 60 }];
    const withEst = renderToStaticMarkup(<MissionOverview model={model} missionId="mission-1" workspaceId="ws-1" planTasks={plan} />);
    expect(withEst).toContain('Est. 40 min');
    expect(withEst).toContain('data-testid="focus-estimate"');
    // A task's indicative estimate only: no date, no mission finish.
    expect(withEst.match(/data-testid="focus-estimate"[^>]*><span>([^<]*)</)?.[1]).toBe('Est. 40 min');
  });

  const base = { tone: 'q' as const, cause: null, since: null, lastEventAt: null, retryAt: null, closed: null };
  const render = (st: Partial<Parameters<typeof FocusStatus>[0]['status']>, now = 1_000_000) =>
    renderToStaticMarkup(<FocusStatus status={{ ...base, word: 'Ready', ...st }} taskId="t1" prWorkerId="w1" serverNow={now} estimateMinutes={null} />);

  it('a failed task in backoff says Failed · CI failed, Retry in 3h 52m and Retry now', () => {
    const out = render({ word: 'Failed', tone: 'bad', cause: 'CI failed', retryAt: 1_000_000 + (3 * 60 + 52) * 60_000 });
    expect(out).toContain('>Failed</span>');
    expect(out).toContain('· CI failed');
    expect(out).toContain('Retry in 3h 52m');
    expect(out).toContain('data-testid="focus-retry-now"');
    expect(out).not.toMatch(/Ready|Scheduled start/);
  });

  it('a running task past the stale threshold reads No activity for 12m in the warning tone', () => {
    const now = 10_000_000;
    const out = render({ word: 'Working', tone: 'act', since: now - 900_000, lastEventAt: now - 12 * 60_000 }, now);
    expect(out).toContain('No activity for 12m');
    expect(out).toContain('data-stale="true"');
    expect(out).toContain('text-status-warning');
    const fresh = render({ word: 'Working', tone: 'act', since: now - 900_000, lastEventAt: now - 14_000 }, now);
    expect(fresh).toContain('Updated 14s ago');
    expect(fresh).toContain('Working 15m 00s');
  });

  it('a replaced PR reads Closed → #N, linked, neutral, with no ✕', () => {
    const out = render({ word: 'Closed', closed: { replacement: { number: 812, url: 'https://github.com/example/app/pull/812' } } });
    expect(out).toMatch(/<a data-testid="focus-status-replacement" href="https:\/\/github.com\/example\/app\/pull\/812"[^>]*>Closed → #812<\/a>/);
    expect(out).not.toContain('✕');
    expect(out).not.toContain('focus-link-replacement');
  });

  it('a closed PR with no known replacement reads Closed, with Link replacement', () => {
    const out = render({ word: 'Closed', closed: { replacement: null } });
    expect(out).toContain('>Closed</span>');
    expect(out).toContain('data-testid="focus-link-replacement"');
    expect(out).toContain('>Link replacement</button>');
  });
});
