/**
 * Mobile rail render branch — docs/specs/timeline-mobile-rail.md acceptance
 * criteria that are about markup rather than the pure model (which
 * `lib/condensed-timeline-rail.test.ts` covers).
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CondensedTimeline from './CondensedTimeline';
import type {
  CondensedTimelineProps,
  CondensedTimelineTask,
  CondensedTimelineWorker,
} from './CondensedTimeline';
import type { ChainUnit } from '@/lib/condensed-timeline';
import type { AttemptStrip as AttemptStripData } from '@/lib/attempt-strip';

function makeTask(id: string, overrides: Partial<CondensedTimelineTask> = {}): CondensedTimelineTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'completed',
    taskCreatedAt: '2026-09-12T10:00:00.000Z',
    taskUpdatedAt: '2026-09-12T10:00:00.000Z',
    roleColor: '#8A8478',
    dependsOn: null,
    pathManifest: null,
    chain: null,
    latestWorker: null,
    taskType: null,
    reviewerNote: null,
    reviewerTaskHref: null,
    reviewerRetryTask: null,
    ...overrides,
  };
}

const chainOf = (head: CondensedTimelineTask, tail: CondensedTimelineTask[] = []): ChainUnit<CondensedTimelineTask> => ({
  head,
  tail,
  shape: tail.length ? 'linear' : 'standalone',
});

const emptyGroups = { waitingOnYou: [], running: [], nextQueued: [], blocked: [], done: [], failed: [] };

const baseProps: CondensedTimelineProps = {
  groups: emptyGroups,
  segments: [],
  effectivePolicyTier: 'auto-threshold',
  policyLabel: 'auto',
  missionId: 'mission-1',
  allTasksCount: 0,
  missionCompleted: false,
  bookkeepingTasks: [],
  view: 'timeline',
  prsMerged: 0,
  prsOpen: 0,
  completedTasks: 0,
  totalTasks: 0,
};

/** The `md:hidden` subtree — everything before the desktop list begins. */
const mobileTree = (html: string) => html.slice(0, html.indexOf('hidden md:block'));
const desktopTree = (html: string) => html.slice(html.indexOf('hidden md:block'));

describe('CondensedTimeline — mobile rail', () => {
  it('collapses a landed chain to one badged row and keeps the members off-screen (AC-1)', () => {
    const chain = chainOf(makeTask('spec', { title: '[spec] Write the spec' }), [
      makeTask('build', { title: '[build] Build it', dependsOn: ['spec'] }),
      makeTask('review', { title: '[review] Review it', dependsOn: ['build'] }),
    ]);
    const html = mobileTree(renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} />));

    expect(html).toContain('▣3');
    expect(html).toContain('Write the spec');
    // Ordinal sub-rows are disclosure, not default posture (Rule D1-4).
    expect(html).not.toContain('Review it');
  });

  it('renders no day-band section headers and no Collapse footer (AC-5)', () => {
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))] }}
        />,
      ),
    );

    expect(html).not.toContain('Today');
    expect(html).not.toContain('Yesterday');
    expect(html).not.toContain('Collapse');
    expect(html).toContain('data-testid="rail-tick"');
  });

  it('renders the goal root with its pass count (AC-6)', () => {
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))] }}
          railGoal={{ total: 3, passed: 2 }}
        />,
      ),
    );

    expect(html).toContain('rail-goal-root');
    expect(html).toContain('2 / 3');
  });

  it('reports an unevaluated gate as ? / N, never 0 / N (Rule D5-3)', () => {
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))] }}
          railGoal={{ total: 2, passed: null }}
        />,
      ),
    );

    expect(html).toContain('? / 2');
    expect(html).not.toContain('0 / 2');
  });

  it('renders no goal root at all when the mission has no criteria (AC-7)', () => {
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))] }} />,
      ),
    );

    expect(html).not.toContain('rail-goal-root');
    expect(html).not.toContain('no goal');
  });

  it('hides a confident approval verdict number from the right column (AC-9)', () => {
    const task = makeTask('t', {
      latestWorker: {
        id: 'w', status: 'completed', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42,
        prLifecycleStatus: 'pr_open', mergedAt: null, completedAt: null, startedAt: null,
        currentAction: null, branch: null, waitingFor: null,
      },
      reviewerNote: {
        type: 'reviewer_approved', title: 'Approved (confidence 0.94)', body: 'LGTM',
        status: 'active', supersededByPrNumber: null,
      },
    });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, waitingOnYou: [chainOf(task)] }} />),
    );

    expect(html).toContain('#42');
    expect(html).not.toContain('0.94');
  });

  it('shows the confidence number when the approval is below the floor (Rule D6-2)', () => {
    const task = makeTask('t', {
      reviewerNote: {
        type: 'reviewer_approved', title: 'Approved (confidence 0.62)', body: 'LGTM',
        status: 'active', supersededByPrNumber: null,
      },
    });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, waitingOnYou: [chainOf(task)] }} />),
    );

    expect(html).toContain('0.62');
  });

  it('shows the confidence number for a non-approve verdict at any value (Rule D6-2)', () => {
    const task = makeTask('t', {
      reviewerNote: {
        type: 'reviewer_request_changes', title: 'Changes Requested (confidence 0.97)', body: 'nope',
        status: 'active', supersededByPrNumber: null,
      },
    });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, waitingOnYou: [chainOf(task)] }} />),
    );

    expect(html).toContain('0.97');
  });

  it('leaves the desktop tree on the six-section list with day banding (AC-8)', () => {
    const html = desktopTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))], nextQueued: [chainOf(makeTask('q', { status: 'pending' }))] }}
          railGoal={{ total: 1, passed: 1 }}
        />,
      ),
    );

    expect(html).toContain('Next queued');
    expect(html).not.toContain('rail-tick');
    expect(html).not.toContain('rail-goal-root');
    expect(html).not.toContain('▣');
  });

  it('leaves the desktop tree byte-for-byte unchanged by every v2 rail input (§9)', () => {
    const groups = {
      ...emptyGroups,
      done: [chainOf(makeTask('spec'), [makeTask('build', { dependsOn: ['spec'] })])],
      failed: [chainOf(makeTask('f', { status: 'failed' }))],
    };
    const render = (extra: Partial<CondensedTimelineProps> = {}) =>
      desktopTree(renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={groups} {...extra} />));

    // The rail's client-state seams are mobile-only: they must not reach the
    // `hidden md:block` subtree at all, let alone change a byte of it.
    expect(render({ disclosedTaskIds: new Set(['spec', 'build']), expandedChainIds: new Set(['spec']) }))
      .toBe(render());

    const desktop = render();
    for (const rail of ['rail-attempt-toggle', 'rail-attempt-disclosure', 'rail-outcome-mark', 'rail-retry-stub', '⌃', '⌄', '▣']) {
      expect(desktop).not.toContain(rail);
    }
  });

  it('renders only the surviving two section labels on the rail (Rule D8-1/D8-2)', () => {
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{
            ...emptyGroups,
            waitingOnYou: [chainOf(makeTask('w'))],
            running: [chainOf(makeTask('r', { status: 'running' }))],
            nextQueued: [chainOf(makeTask('q', { status: 'pending' }))],
            blocked: [chainOf(makeTask('b', { status: 'pending' }))],
          }}
        />,
      ),
    );

    expect(html).toContain('waiting on you');
    expect(html).toContain('running');
    expect(html).not.toContain('Next queued');
    expect(html).not.toContain('Waiting on dependencies');
  });

  it('renders the rail even with an empty mission, without empty chrome', () => {
    const html = mobileTree(renderToStaticMarkup(<CondensedTimeline {...baseProps} />));
    expect(html).toContain('No tasks yet');
    expect(html).not.toContain('rail-tick');
  });
});

// ─── v2: the outcome mark and the disclosure (§6.4, §13) ─────────────────────

/**
 * `renderToStaticMarkup` has no events, so "activated" is exercised through
 * `MobileRail`'s documented fixture seam (`disclosedTaskIds`) — the same
 * technique `AttemptStrip.defaultExpanded` already uses — rather than by
 * simulating a click the server renderer cannot deliver.
 */
const strip = (over: Partial<AttemptStripData> = {}): AttemptStripData => ({
  parentTaskId: 't',
  total: 1,
  dots: '●',
  summary: '1 attempt · reviewer ×1',
  kindCounts: { ci: 0, reviewer: 1, conflict: 0 },
  attempts: [
    {
      id: 'a1',
      status: 'completed',
      reason: 'Reviewer retry #1 of 3 · PR #2295 reviewer requested changes',
      kind: 'reviewer',
      actor: 'Builder',
      settled: true,
      iteration: 1,
      maxIterations: 3,
      href: '/app/tasks/a1',
      prLink: null,
      updatedAt: null,
    },
  ],
  ...over,
});

const worker = (over: Partial<CondensedTimelineWorker> = {}): CondensedTimelineWorker => ({
  id: 'w', status: 'completed', prUrl: 'https://github.com/o/r/pull/2295', prNumber: 2295,
  prLifecycleStatus: 'merged', mergedAt: '2026-09-12T10:00:00.000Z', completedAt: null,
  startedAt: null, currentAction: null, branch: null, waitingFor: null,
  ...over,
});

const railOf = (task: CondensedTimelineTask, extra: Partial<CondensedTimelineProps> = {}) =>
  mobileTree(renderToStaticMarkup(
    <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(task)] }} {...extra} />,
  ));

/** Every outcome mark in render order. `[]` is the healthy path rendering nothing. */
const marks = (html: string) =>
  [...html.matchAll(/data-testid="rail-outcome-mark"[^>]*>([^<]*)</g)].map(m => m[1]);

/** Two attempts, the newer still moving — the §11.8 shape. */
const inFlight = (over: Partial<AttemptStripData['attempts'][number]> = {}) =>
  strip({
    total: 2,
    attempts: [strip().attempts[0], { ...strip().attempts[0], id: 'a2', status: 'running', settled: false, ...over }],
  });

describe('CondensedTimeline — the outcome mark (§6.4)', () => {
  it('spends no ink on a merge with no attempt history (AC-11)', () => {
    const html = railOf(makeTask('t', { latestWorker: worker() }));

    expect(html).toContain('#2295');
    expect(html).toContain('merged');
    expect(marks(html)).toEqual([]);
    expect(html).not.toContain('rail-attempt-toggle');
    expect(html).not.toContain('⌃');
  });

  it('gives a clean merge-after-a-round nothing but the neutral chevron (AC-12, AC-18)', () => {
    const html = railOf(makeTask('t', {
      latestWorker: worker(),
      reviewerNote: { type: 'reviewer_approved', title: 'Approved (confidence 0.94)', body: null, status: 'answered', supersededByPrNumber: null },
      reviewerRetryTask: { id: 'r', status: 'completed', title: 'retry', prNumber: 2295 },
      attempts: strip(),
    }));

    expect(html).toContain('rail-attempt-toggle');
    expect(html).toContain('⌃');
    // AC-18: nothing failed, so the row carries no mark at all.
    expect(marks(html)).toEqual([]);
    // Rule D6-3: the process prose never reaches the row.
    expect(html).not.toContain('1 attempt · reviewer ×1');
  });

  it('marks a merge whose review feedback never landed, inboard of the chevron (AC-13)', () => {
    const html = railOf(makeTask('t', {
      latestWorker: worker(),
      reviewerNote: { type: 'reviewer_request_changes', title: 'Changes requested', body: null, status: 'open', supersededByPrNumber: null },
      attempts: strip(),
    }));

    expect(marks(html)).toEqual(['!']);
    expect(html).toContain('text-status-warning');
    // Rule D6-12: mark first, chevron last, so the chevron sits in a fixed column.
    expect(html.indexOf('rail-outcome-mark')).toBeLessThan(html.indexOf('⌃'));
  });

  it('shows the dot ledger for a re-run in flight and nothing louder (AC-14)', () => {
    const html = railOf(makeTask('t', {
      status: 'running',
      latestWorker: worker({ prLifecycleStatus: 'pr_open', mergedAt: null }),
      attempts: inFlight(),
    }));

    expect(marks(html)).toEqual(['●○']);
    expect(html).toContain('text-text-muted');
  });

  it('dashes the dormant dot behind a mission budget wall (AC-31, Rule D6-11)', () => {
    const html = railOf(makeTask('t', {
      status: 'pending',
      missionBudgetExhausted: true,
      latestWorker: null,
      attempts: inFlight({ status: 'pending' }),
    }));

    expect(marks(html)).toEqual(['●◌']);
  });

  it('marks a died attempt that still has budget with ✗ (AC-15)', () => {
    const html = railOf(makeTask('t', {
      latestWorker: worker({ prLifecycleStatus: 'ci_failed', mergedAt: null }),
      attempts: strip({
        attempts: [{ ...strip().attempts[0], status: 'failed', iteration: 1, maxIterations: 3 }],
      }),
    }));

    expect(marks(html)).toEqual(['✗']);
    expect(html).toContain('text-status-error');
  });

  it('prints N/N and keeps the amber ring when the loop ran out (AC-16, Rule D6-6, D7-4)', () => {
    const exhausted = makeTask('t', {
      status: 'completed',
      latestWorker: worker({ prLifecycleStatus: 'pr_open', mergedAt: null }),
      attempts: strip({
        attempts: [{ ...strip().attempts[0], status: 'failed', iteration: 3, maxIterations: 3 }],
      }),
    });
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, waitingOnYou: [chainOf(exhausted)] }} />,
    ));

    // `3/3` outranks `✗`: the loop is over and a human is the next mover.
    expect(marks(html)).toEqual(['3/3']);
    // The node glyph stays the amber "waiting on you" ring — the task delivered.
    expect(html).toContain('border-2 border-current');
    expect(html).toContain('text-status-warning');
  });

  it('still marks a row whose attempts predate any PR (AC-23, Rule D6-13)', () => {
    const html = railOf(makeTask('t', {
      status: 'running',
      latestWorker: null,
      attempts: inFlight(),
    }));

    expect(marks(html)).toEqual(['●○']);
    expect(html).toContain('rail-attempt-toggle');
  });

  it('renders no mark and no chevron for a failure with no attempt lineage (AC-22)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, failed: [chainOf(makeTask('t', { status: 'failed', latestWorker: null }))] }}
      />,
    ));

    expect(marks(html)).toEqual([]);
    expect(html).not.toContain('rail-attempt-toggle');
    expect(html).not.toContain('⌃');
  });
});

describe('CondensedTimeline — v2 rejections (§3.3, §11.13)', () => {
  it('renders no retry stub, no gutter ✗ and no retry edge stroke anywhere (AC-21)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{
          ...emptyGroups,
          done: [chainOf(makeTask('t', { latestWorker: worker(), attempts: strip() }))],
          failed: [chainOf(makeTask('f', { status: 'failed', attempts: strip({ attempts: [{ ...strip().attempts[0], status: 'failed' }] }) }))],
        }}
      />,
    ));

    expect(html).not.toContain('rail-retry-stub');
    expect(html).not.toContain('border-dashed border-status-error');
    expect(html).not.toContain('border-status-error border-dashed');
  });

  it('never prints the attempt prose on the row itself (Rule D6-3)', () => {
    const html = railOf(makeTask('t', { latestWorker: worker(), attempts: strip({ total: 2, dots: '●●', summary: '2 attempts · CI ×1 · reviewer ×1' }) }));
    expect(html).not.toContain('2 attempts · CI ×1 · reviewer ×1');
  });
});

describe('CondensedTimeline — the disclosure (§13)', () => {
  const disclosable = makeTask('t', {
    latestWorker: worker(),
    reviewerNote: { type: 'reviewer_request_changes', title: 'Changes requested', body: null, status: 'open', supersededByPrNumber: null },
    attempts: strip(),
  });

  it('gives the control a 44px-wide, full-row-height hit box (AC-24, Rule D13-3)', () => {
    const html = railOf(disclosable);

    expect(html).toContain('min-w-[44px]');
    expect(html).toContain('self-stretch');
    // The row grows to the WCAG 2.2 §2.5.8 minimum only when a control is present.
    expect(html).toContain('min-h-[24px]');
  });

  it('keeps the control a sibling of the title link, never nested inside it (Rule D13-2/D13-4)', () => {
    const html = railOf(disclosable);
    const linkStart = html.indexOf('href="/app/tasks/t"');
    const linkEnd = html.indexOf('</a>', linkStart);
    const toggle = html.indexOf('rail-attempt-toggle');

    expect(toggle).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(linkEnd);
  });

  it('reports collapsed state on the control and renders no panel (Rule D13-5)', () => {
    const html = railOf(disclosable);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('⌃');
    expect(html).not.toContain('⌄');
    expect(html).not.toContain('rail-attempt-disclosure');
  });

  it('flips the chevron and opens the panel inside the same rail node when activated (AC-25)', () => {
    const html = railOf(disclosable, { disclosedTaskIds: new Set(['t']) });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('⌄');
    expect(html).toContain('rail-attempt-disclosure');
    // Rule D13-7: the panel lives inside the node's own element, so it lands
    // between `data-rail-node` and the node after it.
    const node = html.indexOf('data-rail-node');
    const panel = html.indexOf('rail-attempt-disclosure');
    expect(panel).toBeGreaterThan(node);
  });

  it('leaves every other row collapsed — the rail is a list, not an accordion (AC-25, Rule D13-8)', () => {
    const other = makeTask('u', { latestWorker: worker({ prNumber: 2296 }), attempts: strip({ parentTaskId: 'u' }) });
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [chainOf(disclosable), chainOf(other)] }}
        disclosedTaskIds={new Set(['t'])}
      />,
    ));

    expect(html.match(/rail-attempt-disclosure/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });

  it('carries exactly one aria-expanded control per panel — AttemptStrip has no toggle of its own (AC-26, Rule D13-9)', () => {
    const html = railOf(disclosable, { disclosedTaskIds: new Set(['t']) });

    expect(html.match(/aria-expanded/g)).toHaveLength(1);
    // The panel still prints the summary the row is forbidden to — as text.
    expect(html).toContain('1 attempt · reviewer ×1');
    expect(html).toContain('Reviewer retry #1 of 3');
  });

  it('leaves tick rows where they were when a row above one expands (AC-19, Rule D13-6)', () => {
    const older = makeTask('old', {
      taskCreatedAt: '2026-09-11T10:00:00.000Z',
      taskUpdatedAt: '2026-09-11T10:00:00.000Z',
      latestWorker: worker({ prNumber: 2289, mergedAt: '2026-09-11T10:00:00.000Z' }),
    });
    const groups = { ...emptyGroups, done: [chainOf(disclosable), chainOf(older)] };
    const order = (html: string) => [
      html.indexOf('data-rail-node'),
      html.indexOf('data-testid="rail-tick"', html.indexOf('data-rail-node')),
    ];

    const collapsed = mobileTree(renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={groups} />));
    const expanded = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={groups} disclosedTaskIds={new Set(['t'])} />,
    ));

    // Same number of ticks, same labels, same relative position.
    expect(collapsed.match(/data-testid="rail-tick"/g)).toEqual(expanded.match(/data-testid="rail-tick"/g));
    expect(order(collapsed)[0]).toBeLessThan(order(collapsed)[1]);
    expect(order(expanded)[0]).toBeLessThan(order(expanded)[1]);
    expect(expanded).toContain('rail-attempt-disclosure');
  });
});

describe('CondensedTimeline — chain rollup (Rule D7-5)', () => {
  const member = makeTask('build', {
    title: '[build] Ledger slice 2',
    dependsOn: ['spec'],
    latestWorker: worker({ prNumber: 2287 }),
    reviewerNote: { type: 'reviewer_request_changes', title: 'Changes requested', body: null, status: 'open', supersededByPrNumber: null },
    attempts: strip({ parentTaskId: 'build' }),
  });
  const chain = chainOf(makeTask('spec', { title: '[spec] Ledger slice 2', latestWorker: worker({ prNumber: 2270 }) }), [
    member,
    makeTask('review', { title: '[review] Ledger slice 2', dependsOn: ['build'], latestWorker: worker() }),
  ]);

  it('keeps the retry off the ordinal count and wears the member outcome collapsed (AC-20)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} />,
    ));

    expect(html).toContain('▣3');
    expect(html).not.toContain('▣4');
    expect(html).toContain('!');
    expect(html).toContain('rail-attempt-toggle');
  });

  it('keeps the rolled-up mark on the chain row when the chain is expanded (AC-20)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} expandedChainIds={new Set(['spec'])} />,
    ));

    expect(html).toContain('▣3');
    // Ordinal sub-rows, each labelled with its own taskType (Rule D1-3).
    expect(html).toContain('>2</span><a class="min-w-0 flex-1 truncate');
    expect(html).toContain('>BUILD </span>');
    // Two marks now: the chain's rolled-up one and the member's own (§11.12b).
    expect(html.match(/rail-outcome-mark/g)).toHaveLength(2);
    expect(marks(html)).toEqual(['!', '!']);
  });

  it('names the terminal member\'s PR on the collapsed row, not the head\'s (§1.3)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} />,
    ));

    // spec=#2270 (head), build=#2287, review=#2295 (terminal) — §11.12a wants #2295.
    expect(html).toContain('#2295');
    expect(html).not.toContain('#2270');
    expect(html).not.toContain('#2287');
  });

  it('still shows each member\'s own PR on the expanded ordinal sub-rows (§1.3)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} expandedChainIds={new Set(['spec'])} />,
    ));

    expect(html).toContain('#2270');
    expect(html).toContain('#2287');
    expect(html).toContain('#2295');
  });
});
