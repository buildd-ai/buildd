/**
 * The header block and the card subtitle, asserted against the SHARED
 * derivation rather than against a string either of them owns.
 *
 * Every situation here is produced by `deriveMissionStateView` — no test builds
 * a `MissionSituation` by hand. A component that drifted into phrasing its own
 * sentence would pass a literal-string test and fail these.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionSituationBlock, { MissionSituationLine, affordanceFor } from './MissionSituationBlock';
import { deriveMissionStateView, type MissionStateInput } from '@/lib/mission-state-view';
import { buildStateBecause } from '@/lib/explain-because';

const base: MissionStateInput = {
  status: 'active',
  isHeld: false,
  activeAgents: 0,
  health: 'NOMINAL',
};

const missionPrOpen: MissionStateInput = {
  ...base,
  progress: 100,
  completion: {
    ok: false,
    code: 'awaiting_mission_pr',
    reason: 'the mission PR has not merged',
    awaitingMerge: 1,
    awaitingMergeDetails: [],
  },
  missionPr: { prNumber: 4242, prUrl: 'https://example.invalid/pr/4242' },
};

function render(input: MissionStateInput) {
  const view = deriveMissionStateView(input);
  const because = buildStateBecause(view, { missionId: 'm-1' });
  return {
    view,
    html: renderToStaticMarkup(
      <MissionSituationBlock missionId="m-1" situation={view.situation} because={because} />,
    ),
  };
}

describe('mission header — all tasks merged, mission PR open', () => {
  it('states waiting on you and offers merge as the primary action', () => {
    const { html } = render(missionPrOpen);

    expect(html).toContain('Waiting on you to merge the mission PR #4242.');
    expect(html).toContain('data-testid="mission-primary-action"');
    expect(html).toContain('https://example.invalid/pr/4242');
  });

  it('does not make Delete, Disarm or Complete the primary action', () => {
    // Those are capabilities, and a capability is never a `WaitingOnDescriptor`
    // — so there is no path by which one can reach the primary slot.
    const { html } = render(missionPrOpen);

    for (const capability of ['Delete', 'Disarm', 'Complete mission', 'Edit schedule', 'Plan now']) {
      expect(html).not.toContain(capability);
    }
  });
});

describe('mission header — Part 2 regression: a live worker must not suppress the PR', () => {
  it('still states the open mission PR when the mission reads running', () => {
    const { view, html } = render({ ...missionPrOpen, activeAgents: 1 });

    expect(view.kind).toBe('running');
    expect(html).toContain('Running (1 agent). Waiting on you to merge the mission PR #4242.');
    expect(html).toContain('data-testid="mission-primary-action"');
  });

  it('names a repeated claim-loop deferral and its reason', () => {
    const { html } = render({
      ...base,
      activeAgents: 1,
      deferrals: [{
        taskId: 'task-stuck',
        reason: 'workspace_cap',
        consecutiveDeferrals: 13,
        firstDeferredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }],
    });

    expect(html).toContain('13 times in a row');
    expect(html).toContain('workspace_cap');
  });
});

describe('mission header — genuinely mid-flight, nothing outstanding', () => {
  it('says running and offers no action at all', () => {
    const { html } = render({ ...base, activeAgents: 3 });

    expect(html).toContain('Running: 3 agents in flight, nothing outstanding.');
    expect(html).not.toContain('data-testid="mission-primary-action"');
    expect(html).not.toContain('data-testid="mission-also-outstanding"');
  });

  it('says nothing-to-do plainly when idle', () => {
    const { html } = render(base);

    expect(html).toContain('Nothing to do. No source reports outstanding work.');
    expect(html).not.toContain('data-testid="mission-primary-action"');
  });
});

describe('provenance stays out of the reader’s view', () => {
  it('never prints "from <source>"; the source rides on a data attribute for diagnostics', () => {
    const { view, html } = render({ ...base, status: 'completed' });
    expect(view.situation.derivedFrom).toBe('mission.status');
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toContain('mission.status');
    expect(html).toContain('data-derived-from="mission.status"');
  });
});

describe('the why, with its hard ref linked', () => {
  it('renders the top of the causal chain and links its PR', () => {
    const view = deriveMissionStateView({
      ...base,
      completion: {
        ok: false,
        code: 'awaiting_merge',
        reason: 'a task PR has not merged',
        awaitingMerge: 1,
        awaitingMergeDetails: [
          { taskId: 't-1', title: 'Wire the route', prNumber: 9001, prUrl: 'https://example.invalid/pr/9001' },
        ],
      },
    });
    const because = buildStateBecause(view, { missionId: 'm-1' }, {
      unmergedPrs: [{ taskId: 't-1', title: 'Wire the route', prNumber: 9001, prUrl: 'https://example.invalid/pr/9001' }],
    });
    const html = renderToStaticMarkup(
      <MissionSituationBlock missionId="m-1" situation={view.situation} because={because} />,
    );

    expect(html).toContain('Wire the route');
    expect(html).toContain('#9001');
    expect(html).toContain('https://example.invalid/pr/9001');
  });
});

describe('F2: a failing criterion is said once, and names what holds it', () => {
  const failing = {
    ...base,
    progress: 100,
    criteriaItems: [{ verdict: 'fail', type: 'no_open_tasks', label: 'no open tasks' }],
    criteriaGate: { state: 'failing' as const, label: 'Criteria failing', tone: 'warning' as const, detail: 'no open tasks' },
  };

  it('stale verdict: headline plus the re-run instruction, no restated causal claim', () => {
    const { html, view } = render({ ...failing, openTasks: [] });
    expect(html).toContain('no task is open.');
    expect(html).toContain(view.situation.nextAction!);
    expect(html).not.toContain('returned a failing verdict');
    expect(html.split('no open tasks').length - 1).toBe(1);
  });

  it('open blockers: up to three linked into the task sheet, then +N more', () => {
    const openTasks = ['a', 'b', 'c', 'd'].map(id => ({ id: `t-${id}`, status: 'pending', title: `Blocker ${id}` }));
    const { html } = render({ ...failing, openTasks });
    expect(html).toContain('data-testid="mission-situation-blockers"');
    expect(html).toContain('Blocker a');
    expect(html).toContain('Blocker c');
    expect(html).not.toContain('Blocker d');
    expect(html).toContain('+1 more');
    expect(html).toContain('data-task-id="t-a"');
    expect(html).toContain('/app/missions/m-1?');
    expect(html).toContain('· queued');
  });
});

describe('the card renders the header sentence', () => {
  const cases: Array<[string, MissionStateInput]> = [
    ['mission PR open', missionPrOpen],
    ['running with an open PR', { ...missionPrOpen, activeAgents: 1 }],
    ['running and quiet', { ...base, activeAgents: 2 }],
    ['idle', base],
    ['held', { ...base, isHeld: true }],
    ['failing', { ...base, health: 'FAILING', failedTasks: [{ id: 't-9', title: 'Write the migration' }] }],
  ];

  for (const [name, input] of cases) {
    it(`matches the header for: ${name}`, () => {
      // The assertion is the SHARED CALL, not a literal: both surfaces read
      // `deriveMissionStateView(...).situation.headline`, so they cannot drift
      // without this failing.
      const view = deriveMissionStateView(input);
      const headerHtml = renderToStaticMarkup(
        <MissionSituationBlock missionId="m-1" situation={view.situation} because={[]} />,
      );
      const cardHtml = renderToStaticMarkup(<MissionSituationLine situation={view.situation} />);

      expect(cardHtml).toContain(view.situation.headline);
      expect(headerHtml).toContain(view.situation.headline);
    });
  }

  it('offers no affordance on a card — a list row states, it does not act', () => {
    const view = deriveMissionStateView(missionPrOpen);
    const cardHtml = renderToStaticMarkup(<MissionSituationLine situation={view.situation} />);

    expect(cardHtml).not.toContain('mission-primary-action');
  });
});

describe('affordanceFor', () => {
  it('returns null for a merge with no href, rather than a button with nowhere to go', () => {
    const view = deriveMissionStateView({
      ...base,
      workState: { complete: false, reason: 'prs_unmerged', unfinishedTaskCount: 0, unmergedPrCount: 2 },
    });

    expect(view.situation.focus?.kind).toBe('merge');
    expect(affordanceFor(view.situation.focus, { missionId: 'm-1' })).toBeNull();
  });

  it('returns null when nothing is outstanding', () => {
    expect(affordanceFor(null, { missionId: 'm-1' })).toBeNull();
  });

  it('sends a criteria hold to the Verified pill, a real target on this page (AC-16)', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaGate: { state: 'failing', tone: 'warning', label: 'FAIL', detail: 'ships on trunk' },
      criteriaItems: [{ verdict: 'fail', label: 'ships on trunk' }],
    });

    expect(affordanceFor(view.situation.focus, { missionId: 'm-1' })).toEqual({
      kind: 'internal',
      label: 'Go to goal criteria',
      href: '#mission-criteria',
    });
  });

  it('offers no criteria link when the page renders no criteria target (terminal mission, pill hidden)', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaGate: { state: 'failing', tone: 'warning', label: 'FAIL', detail: 'ships on trunk' },
      criteriaItems: [{ verdict: 'fail', label: 'ships on trunk' }],
    });
    expect(affordanceFor(view.situation.focus, { missionId: 'm-1', criteriaReachable: false })).toBeNull();
    const html = renderToStaticMarkup(
      <MissionSituationBlock missionId="m-1" situation={view.situation} because={[]} criteriaReachable={false} />,
    );
    expect(html).not.toContain('#mission-criteria');
  });

  // Regression: a running mission's open task was offered as "the blocking
  // task" — the same false claim as "no live worker", in button form.
  it('does not call an open task "blocking" while agents are running on the mission', () => {
    const running = deriveMissionStateView({
      ...base,
      activeAgents: 1,
      openTasks: [{ id: 't-1', status: 'in_progress', title: 'Build the page' }],
    });
    expect(running.situation.focus?.kind).toBe('task');
    expect(affordanceFor(running.situation.focus, { missionId: 'm-1' })?.label).toBe('View the open task');

    const stalled = deriveMissionStateView({
      ...base,
      health: 'STALLED',
      openTasks: [{ id: 't-1', status: 'in_progress', title: 'Build the page' }],
    });
    expect(stalled.situation.focus?.kind).toBe('task');
    expect(affordanceFor(stalled.situation.focus, { missionId: 'm-1' })?.label).toBe('Open the blocking task');
  });

  // Regression: a stalled mission offered "Open the blocking task" on a task
  // that was only waiting on its dependency — the one row that cannot be
  // blocking anything.
  it('never cites a dependency-blocked task as the blocker', () => {
    const stalled = deriveMissionStateView({
      ...base,
      health: 'STALLED',
      openTasks: [
        { id: 't-dep', status: 'pending', title: 'Second step', waitingOnTaskIds: ['t-first'] },
        { id: 't-first', status: 'pending', title: 'First step' },
      ],
    });
    const focus = stalled.situation.focus;
    if (focus?.kind !== 'task') throw new Error('expected a task focus');
    expect(focus.taskIds[0]).toBe('t-first');
    expect(focus.taskIds).not.toContain('t-dep');
    expect(affordanceFor(focus, { missionId: 'm-1' })).toMatchObject({ taskId: 't-first' });
  });

  it('cites the unmet dependency when every open row is waiting on one', () => {
    const view = deriveMissionStateView({
      ...base,
      health: 'NOMINAL',
      completion: { ok: false, code: 'pending_deliverables', reason: '1 open', pendingDeliverables: 1, pendingByStatus: { pending: 1 } },
      openTasks: [{ id: 't-dep', status: 'pending', title: 'Second step', waitingOnTaskIds: ['t-first'] }],
    });
    const focus = view.situation.focus;
    if (focus?.kind !== 'task') throw new Error('expected a task focus');
    expect(focus.taskIds).toEqual(['t-first']);
    expect(focus.tone).not.toBe('warning');
    expect(affordanceFor(focus, { missionId: 'm-1' })?.label).not.toBe('Open the blocking task');
  });

  it("opens a mission task in the sheet over the mission, never a bare task-page push", () => {
    const failed = { kind: 'task_failed' as const, tone: 'error' as const, label: 'A task failed', infra: false, taskIds: ['t-9'], titles: ['Example'] };
    expect(affordanceFor(failed, { missionId: 'm-1' })).toEqual({
      kind: 'internal',
      label: 'Open the failed task',
      href: '/app/missions/m-1?task=t-9',
      taskId: 't-9',
    });
  });

  it('marks a task affordance with data-task-id so the sheet owner intercepts it', () => {
    const view = deriveMissionStateView(base);
    const situation = { ...view.situation, focus: { kind: 'task_failed' as const, tone: 'error' as const, label: 'A task failed', infra: false, taskIds: ['t-9'], titles: ['Example'] } };
    const html = renderToStaticMarkup(<MissionSituationBlock missionId="m-1" situation={situation} because={[]} />);
    expect(html).toContain('data-task-id="t-9"');
    expect(html).toContain('href="/app/missions/m-1?task=t-9"');
  });
});
