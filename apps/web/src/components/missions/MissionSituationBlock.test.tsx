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
    expect(html).toContain('Running (1 agent) — but waiting on you to merge the mission PR #4242.');
    expect(html).toContain('data-testid="mission-primary-action"');
  });

  it('names a repeated claim-loop deferral and its reason', () => {
    const { html } = render({
      ...base,
      activeAgents: 1,
      deferrals: [{ taskId: 'task-stuck', reason: 'workspace_cap', consecutiveDeferrals: 13, firstDeferredAt: null }],
    });

    expect(html).toContain('13 times in a row');
    expect(html).toContain('workspace_cap');
  });
});

describe('mission header — genuinely mid-flight, nothing outstanding', () => {
  it('says running and offers no action at all', () => {
    const { html } = render({ ...base, activeAgents: 3 });

    expect(html).toContain('Running — 3 agents in flight, nothing outstanding.');
    expect(html).not.toContain('data-testid="mission-primary-action"');
    expect(html).not.toContain('data-testid="mission-also-outstanding"');
  });

  it('says nothing-to-do plainly when idle', () => {
    const { html } = render(base);

    expect(html).toContain('Nothing to do — no source reports anything outstanding.');
    expect(html).not.toContain('data-testid="mission-primary-action"');
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

  it('sends a criteria hold to the goal-criteria section', () => {
    const view = deriveMissionStateView({
      ...base,
      criteriaGate: { state: 'failing', tone: 'warning', label: 'FAIL', detail: 'ships on trunk' },
      criteriaItems: [{ verdict: 'fail', label: 'ships on trunk' }],
    });

    expect(affordanceFor(view.situation.focus, { missionId: 'm-1' })).toEqual({
      kind: 'internal',
      label: 'Go to goal criteria',
      href: '#mission-goal-criteria',
    });
  });
});
