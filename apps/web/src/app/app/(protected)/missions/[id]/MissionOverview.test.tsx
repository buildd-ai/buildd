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
const { default: MissionOverview } = await import('./MissionOverview');
const { railLines, overviewLayout } = await import('@/lib/mission-overview');
const { dagBoard, dagId, DAG_SPECS, overviewWavesBoard } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');
const legendText = (markup: string) => [...(markup.match(/data-testid="overview-counts"[\s\S]*?<\/p>/)?.[0] ?? '').matchAll(/data-legend="[^"]+"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</g)].map(m => m[1]);

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
    expect(legendText(html)).toEqual(['1 done', '1 in progress', '3 waiting on tasks']);
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

  it('draws Build › Audit › Land once (the Lifecycle line), not a second stage grid', () => {
    expect(out.match(/data-testid="lifecycle"/g)).toHaveLength(1);
    expect(out).not.toContain('data-testid="delivery-stages"');
  });

  it('the counts line is build counts only; criteria live in the Verified pill and the rail', () => {
    const counts = legendText(out);
    expect(counts[0]).toBe('3 done');
    expect(counts.join(' ')).not.toMatch(/criteri/);
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
    expect(out).toMatch(/aria-label="\d\d Held: /);
  });

  it('the legend says the groups in words', () => {
    expect(legendText(out)).toEqual(['10 done', '2 in progress', '4 waiting on tasks', '2 next in line', '1 held', '1 not started', '1 check']);
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
