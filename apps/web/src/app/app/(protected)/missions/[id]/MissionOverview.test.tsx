/**
 * The Overview (Navigation d25d923d R-3 to R-6, R-15, R-16): the stage line,
 * the bar with no numbers, the summary line and task list, the decision
 * cards, the raised History line, and only the current stage. Static markup
 * from the strip fixtures.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionOverview } = await import('./MissionOverview');
const { overviewLayout } = await import('@/lib/mission-overview');
const { dagBoard, DAG_SPECS, overviewWavesBoard } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');
const { missionDecisions, historyRaised } = await import('@/lib/mission-decisions');

const spec = DAG_SPECS.linear;
const html = renderToStaticMarkup(<MissionOverview model={dagBoard(spec)} missionId="mission-1" />);

const compact = await import('@/app/app/dev/fixtures/mission-detail-compact-fixtures');

describe('MissionOverview', () => {
  it('draws the bar with no tick numbers, the summary line and the list; no focus card, legend, rail or stepper (R-1, R-3, R-5)', () => {
    expect(html).toContain('data-size="lg"');
    expect(html).not.toContain('data-testid="task-strip-ticks"');
    expect(html).toContain('data-testid="mission-build-summary"');
    expect(html).toContain('data-testid="mission-task-list"');
    expect(html).not.toContain('data-testid="focus-card"');
    expect(html).not.toContain('data-testid="overview-stepper"');
    expect(html).not.toContain('data-testid="overview-counts"');
    expect(html).not.toContain('data-testid="overview-rail"');
    expect(html).not.toMatch(/role="dialog"|data-testid="task-sheet/);
  });

  it('names tasks in the bar and the list, never numbers', () => {
    expect(html).not.toMatch(/aria-label="\d\d /);
    expect(html).toMatch(/aria-label="feat: task A: merged"/);
    const list = html.slice(html.indexOf('data-testid="mission-task-list"'));
    expect(list).toContain('feat: task B');
    expect(list).not.toMatch(/>0\d</);
  });

  it('a row opens its task page, and carries the #t- anchor', () => {
    expect(html).toMatch(/id="t-[^"]+" data-task-id="[^"]+" data-testid="mission-task-row"/);
    expect(html).toMatch(/data-testid="mission-task-row"[^>]*><a [^>]*href="\/app\/tasks\//);
  });
});

describe('MissionOverview over AC-4\u2019s mission (16 tasks)', () => {
  const f = compact.missionDetailCompactFixture('building', null);
  const out = renderToStaticMarkup(<MissionOverview model={f.model} missionId="mission-1" checks={f.checks} outcomeSpecTitles={f.specTitles} decisions={f.decisions} history={f.history} />);

  it('the decision card, bar, summary line and the decision\u2019s row are visible; no Verify or Deliver card; no tab bar', () => {
    expect(out).toContain('data-testid="decision-card"');
    expect(out).toContain('data-testid="task-strip"');
    expect(out).toContain('11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting');
    expect(out).toMatch(/data-testid="mission-task-row" data-state="decision"/);
    expect(out).toContain('data-stage="build"');
    expect(out).not.toContain('data-testid="mission-checks"');
    expect(out).not.toContain('data-testid="build-complete-bar"');
    expect(out).not.toContain('data-testid="mission-delivered-line"');
    expect(out).not.toContain('role="tablist"');
  });

  it('the header reads one spec line and the stage line names the current stage only', () => {
    expect(out).toMatch(/data-testid="mission-outcome-spec"[^>]*>.*Spec.*Cloud runner: deploy from Settings/);
    expect(out).not.toMatch(/data-testid="mission-outcome-spec"[^>]*>[^<]*rev /);
    const steps = [...out.matchAll(/data-step="([^"]+)" data-state="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);
    expect(steps).toEqual(['build:now', 'verify:todo', 'deliver:todo']);
    expect((out.match(/data-testid="mission-check-rail-text"/g) ?? []).length).toBe(1);
  });

  it('the decision card names the task, every task waiting on it, each option\u2019s effect, Answer differently and Not now (AC-10)', () => {
    const card = out.slice(out.indexOf('data-testid="decision-card"'), out.indexOf('data-testid="task-strip"'));
    expect(card).toContain('Mirror the runner image to Docker Hub');
    expect(card).toContain('The release publishes an image digest');
    // What waits comes from the projection (spec 1b257609), as a link, with each option's effect and the expiry.
    expect(card).toMatch(/Waits on this: <\/span><a [^>]*href="\/app\/tasks\/[^"]+"[^>]*>The release publishes an image digest<\/a>/);
    expect(card).toContain('Finishes the task: The release publishes an image digest starts');
    expect(card).toContain('Expires in 3 hours 59 minutes, then the task starts again and the agent goes with Provide a token.');
    expect(card).toContain('How should Docker Hub credentials be set up?');
    expect((card.match(/data-testid="decision-option-effect"/g) ?? []).length).toBe(2);
    expect(card).toContain('Answer differently');
    expect(card).toContain('Not now');
  });

  it('with three open decisions one card leads and the rest are reached from it, so the bar stays on the first screen (AC-4)', () => {
    const d = f.decisions[0];
    const three = [d, { ...d, key: 'note:x2', question: 'Second?' }, { ...d, key: 'note:x3', question: 'Third?' }];
    const many = renderToStaticMarkup(<MissionOverview model={f.model} missionId="mission-1" checks={f.checks} decisions={three} history={f.history} />);
    expect((many.match(/data-testid="decision-card"/g) ?? []).length).toBe(1);
    expect(many).not.toContain('Second?');
    expect(many).toMatch(/data-testid="decision-more"[^>]*>[^<]*2 more decisions/);
    expect(many.indexOf('data-testid="decision-more"')).toBeLessThan(many.indexOf('data-testid="task-strip"'));
    // One decision: no more-line.
    expect(out).not.toContain('data-testid="decision-more"');
  });

  it('the bar draws the five looks: merged, running, person, waiting', () => {
    const looks = [...out.matchAll(/data-testid="task-strip-fill"[^>]*data-look="([a-z]+)"/g)].map(m => m[1]);
    expect(looks.filter(l => l === 'merged')).toHaveLength(11);
    expect(looks).toContain('running');
    expect(looks).toContain('person');
    expect(looks).toContain('waiting');
  });

  it('a held task reads Queued with its age, never Running or Next in line (AC-14)', () => {
    const list = out.slice(out.indexOf('data-testid="mission-task-list"'));
    expect(list).toMatch(/Queued \d+[mh]/);
    expect(list).not.toContain('Next in line');
    expect(list).toMatch(/Fixing · CI failed · resumes \d\d:\d\d/);
  });

  it('without estimates the summary names no finish; with them it ends finish depends on <task> (R-22, AC-18)', () => {
    expect(out).not.toContain('finish depends on');
    const withEstimates = renderToStaticMarkup(<MissionOverview model={f.model} missionId="mission-1" checks={f.checks} decisions={f.decisions} expectedMinutes={f.expectedMinutes!} />);
    const summary = withEstimates.match(/data-testid="mission-build-summary"[^>]*>([^<]*)</)?.[1];
    expect(summary).toBe('11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting · finish depends on Mirror the runner image to Docker Hub, then The release publishes an image digest');
  });
});

describe('MissionOverview, 11 tasks with delivery', () => {
  const f = compact.missionDetailCompactFixture('eleven', null);
  const out = renderToStaticMarkup(<MissionOverview model={f.model} missionId="mission-1" />);

  it('draws no per-task stage grid: a task’s track is on its page', () => {
    expect(out).not.toContain('data-testid="lifecycle"');
    expect(out).not.toContain('data-testid="delivery-stages"');
  });

  it('the summary line is build counts only; merged tasks fold into one row', () => {
    expect(out).toMatch(/data-testid="mission-build-summary"[^>]*>3 of 11 merged/);
    expect(out).toContain('3 merged ›');
    expect(out).not.toMatch(/criteri/);
  });
});

// Spec f7f67f1a R-1, R-3 (the bar's groups and outline).
describe('MissionOverview groups', () => {
  const model = overviewWavesBoard(20);
  const layout = overviewLayout(model);
  const out = renderToStaticMarkup(<MissionOverview model={model} missionId="mission-1" />);
  const cellIds = [...out.matchAll(/<button[^>]*data-id="([^"]+)"/g)].map(m => m[1]);

  it('draws cells merged first, then in progress, waiting and checks, so the keys step in that order', () => {
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

  it('a two-task mission draws two compact cells, not two wide slabs', () => {
    const two = renderToStaticMarkup(<MissionOverview model={overviewWavesBoard(2)} missionId="mission-1" />);
    expect(two).toContain('md:[--cell:minmax(0,56px)]');
    expect(two.match(/<button[^>]*data-id=/g)).toHaveLength(2);
  });
});

const { handoffFixture } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');

describe('MissionOverview stages (Navigation R-15, AC-9; spec f7f67f1a R-11 to R-24)', () => {
  const base = { now: Date.UTC(2026, 9, 14, 12), missionCreatedAt: Date.UTC(2026, 9, 14, 11), missionStatus: 'active' as const };
  const render = (variant: Parameters<typeof handoffFixture>[0]) => {
    const f = handoffFixture(variant, base);
    return renderToStaticMarkup(
      <MissionOverview model={f.model} missionId="mission-1" executor={f.executor} checks={f.checks} planTasks={f.planTasks} held={f.held} />,
    );
  };
  const rows = (markup: string) => [...markup.matchAll(/data-testid="mission-check" data-kind="([^"]+)" data-status="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);
  const rail = (markup: string) => [...markup.matchAll(/data-step="([^"]+)" data-state="([^"]+)"/g)].map(m => `${m[1]}:${m[2]}`);

  it('while building: the bar and list stay, Build is the stage, and the estimate says build only', () => {
    const html = render('handoff-building');
    expect(html).toContain('data-stage="build"');
    expect(html).toContain('data-testid="task-strip"');
    expect(html).not.toContain('data-testid="build-complete-bar"');
    expect(rail(html)).toEqual(['build:now', 'verify:todo', 'deliver:todo']);
    expect(html).toMatch(/data-testid="overview-estimate"[^>]*>build only: /);
  });

  it('build done: the bar folds into one line and Verify is the page, with no overall done claim', () => {
    const html = render('handoff-verifying');
    expect(html).toContain('data-stage="verify"');
    expect(html).toContain('data-testid="build-complete-bar"');
    expect(html).toContain('10 tasks merged ›');
    expect(html).not.toContain('data-testid="task-strip"');
    expect(html).not.toContain('data-testid="mission-build-summary"');
    expect(rows(html)).toEqual(['visual:running', 'mission_pr:queued', 'criterion:queued', 'release:queued']);
    expect(rail(html)).toEqual(['build:done', 'verify:now', 'deliver:todo']);
    expect(html).not.toMatch(/Delivered|%/);
  });

  it('a visual finding shows its fix inside the check, and the fix is not in the build count', () => {
    const html = render('handoff-repairing');
    expect(rows(html)[0]).toBe('visual:finding');
    expect(html).toContain('data-testid="mission-check-repairs"');
    expect(html).toContain('filter selection resets after a refresh');
    expect(html).toContain('10 tasks merged ›');
  });

  it('reviewer merge shows no owner button; human merge names the owner but adds no Approve or Merge button here', () => {
    const reviewer = render('handoff-reviewer');
    expect(reviewer).toContain('reviewer deciding');
    const human = render('handoff-approval');
    expect(human).toContain('approve to deliver');
    for (const html of [reviewer, human]) {
      const card = html.slice(html.indexOf('data-testid="mission-checks"'));
      expect(card).not.toMatch(/<button[^>]*>(Approve|Merge)[^<]*<\/button>/);
    }
  });

  it('a failed deploy never reads delivered; a healthy one reads Delivered into the branch with the requirements folded', () => {
    const failed = render('handoff-deploy-failed');
    expect(rail(failed)).toEqual(['build:done', 'verify:done', 'deliver:held']);
    expect(failed).not.toContain('data-testid="mission-delivered-line"');
    const healthy = render('handoff-delivered');
    expect(rail(healthy)).toEqual(['build:done', 'verify:done', 'deliver:done']);
    expect(healthy).toContain('data-stage="deliver"');
    // The catalog's word for the delivered state (terms.ts `mission.done`), then the branch.
    expect(healthy).toMatch(/data-testid="mission-delivered-line"[^>]*>.*Done · merged into dev/);
    expect(healthy).toContain('data-testid="mission-requirements-fold"');
    expect(healthy).toMatch(/Requirements.*\d+ of \d+ met ›/);
    expect(healthy).not.toContain('data-testid="mission-build-summary"');
  });

  it('a reopened task returns the Build stage (AC-9)', () => {
    const f = handoffFixture('handoff-verifying', base);
    const [first] = Object.keys(f.model.tasks).filter(id => f.model.tasks[id].deliverableRole === 'build');
    const reopened = { ...f.model, tasks: { ...f.model.tasks, [first]: { ...f.model.tasks[first], status: 'running' as const, executing: true, reopened: true } } };
    const html = renderToStaticMarkup(<MissionOverview model={reopened} missionId="mission-1" checks={f.checks} history={historyRaised(reopened, [])} />);
    expect(html).toContain('data-stage="build"');
    expect(html).toContain('data-testid="task-strip"');
    expect(html).toMatch(/data-testid="mission-history-raised" data-kind="reopened"/);
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

describe('History raised (Navigation R-6, AC-8)', () => {
  it('an open organizer decision raises one History line above the list, naming it', () => {
    const model = dagBoard(spec);
    const notes = [{ id: 'n1', type: 'question', status: 'open', title: 'Keep the legacy export?', body: null, createdAt: Date.UTC(2026, 0, 1) }];
    const history = historyRaised(model, notes);
    const decisions = missionDecisions({ model, notes, mission: { id: 'mission-1', title: 'M', href: '/app/missions/mission-1' }, hrefFor: id => `/app/tasks/${id}` });
    const html = renderToStaticMarkup(<MissionOverview model={model} missionId="mission-1" decisions={decisions} history={history} />);
    const raised = html.match(/data-testid="mission-history-raised"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(raised).toContain('data-kind="decision"');
    expect(raised).toContain('Decision open: Keep the legacy export?');
    expect(raised).toContain('layout=feed');
    expect(html.indexOf('data-testid="mission-history-raised"')).toBeLessThan(html.indexOf('data-testid="mission-task-list"'));
    expect((html.match(/data-testid="mission-history-raised"/g) ?? []).length).toBe(1);
  });
});
