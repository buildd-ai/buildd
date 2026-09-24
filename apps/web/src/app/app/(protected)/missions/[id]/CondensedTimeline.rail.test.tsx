/**
 * Mobile rail render branch — docs/specs/timeline-mobile-rail.md acceptance
 * criteria that are about markup rather than the pure model (which
 * `lib/condensed-timeline-rail.test.ts` covers).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import CondensedTimeline from './CondensedTimeline';
import type {
  BookkeepingTask,
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

  it('gives the ▣N chain badge its own 24px row even with no attempt history (AC-1, Rule D13-10)', () => {
    // A clean, fully-merged multi-task chain: headOutcome.hasAttempts is false,
    // so the right-column disclosure is null and `roomy` must come from the
    // badge alone, not from `disclosure`.
    const chain = chainOf(makeTask('spec', { title: '[spec] Write the spec' }), [
      makeTask('build', { title: '[build] Build it', dependsOn: ['spec'] }),
      makeTask('review', { title: '[review] Review it', dependsOn: ['build'] }),
    ]);
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} />),
    );

    const badgeIndex = html.indexOf('▣3');
    expect(badgeIndex).toBeGreaterThan(-1);
    const rowStart = html.lastIndexOf('<div class="flex gap-1.5', badgeIndex);
    const rowOpenTag = html.slice(rowStart, html.indexOf('>', rowStart));

    expect(rowOpenTag).toContain('min-h-[24px]');
    expect(rowOpenTag).not.toContain('min-h-[18px]');
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

    // v3: `▣3` → `▼3` is the collapsed/expanded indication (Rule D1-6).
    expect(html).toContain('▼3');
    expect(html).not.toContain('▣3');
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

  it('keeps the head\'s reviewer-confidence flag on the collapsed row even though the PR badge names the terminal member (Rule D6-2)', () => {
    // Head carries its own PR (#2287) and a sub-floor confidence note; the
    // terminal member carries a different PR (#2295) and no note at all.
    // Redirecting the PR badge to the terminal member must not also redirect
    // which task's reviewerNote gets read — those are independent signals.
    const headWithNote = makeTask('build', {
      title: '[build] Ledger slice 2',
      latestWorker: worker({ prNumber: 2287 }),
      reviewerNote: {
        type: 'reviewer_approved',
        title: 'Approved (confidence 0.62)',
        body: null,
        status: 'answered',
        supersededByPrNumber: null,
      },
    });
    const noteChain = chainOf(headWithNote, [
      makeTask('review', { title: '[review] Ledger slice 2', dependsOn: ['build'], latestWorker: worker({ prNumber: 2295 }) }),
    ]);

    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [noteChain] }} />,
    ));

    expect(html).toContain('#2295');
    expect(html).not.toContain('#2287');
    expect(html).toContain('0.62');
  });
});

// ─── v3: which element owns a tap (§13.3, §13.4) ─────────────────────────────

/** Void/self-closing elements never open a scope in `enclosingTaskIds`. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Every `data-task-id` in scope at `index`, outermost first.
 *
 * This is the delegated handler's own question: `TaskPanelWrapper` runs
 * `closest('[data-task-id]')` from the click target, so the LAST entry is the
 * task a tap at that point would peek, and `[]` means a tap there peeks nothing
 * (Rule D13-13).
 */
function enclosingTaskIds(html: string, index: number): string[] {
  const stack: (string | null)[] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    // A match that STARTS before `index` but ends after it is the element the
    // index sits inside the opening tag of — it counts as enclosing.
    if (m.index >= index) break;
    const [, closing, name, attrs] = m;
    if (closing) { stack.pop(); continue; }
    if (VOID_TAGS.has(name.toLowerCase()) || attrs.trimEnd().endsWith('/')) continue;
    stack.push(attrs.match(/data-task-id="([^"]*)"/)?.[1] ?? null);
  }
  return stack.filter((v): v is string => v != null);
}

/** The `<button …>…</button>` whose opening tag carries `data-testid={id}`. */
function controlAt(html: string, testid: string): { start: number; open: string; inner: string } {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<', at);
  const openEnd = html.indexOf('>', at);
  const close = html.indexOf('</button>', openEnd);
  return { start, open: html.slice(start, openEnd + 1), inner: html.slice(start, close + 9) };
}

/** The `<div class="flex gap-1.5 …">` row that encloses `index`. */
function rowAt(html: string, index: number): string {
  const start = html.lastIndexOf('<div class="flex gap-1.5', index);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="flex gap-1.5', index + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

const memberWorker = (n: number) =>
  worker({ prNumber: n, prUrl: `https://github.com/o/r/pull/${n}` });

/** §11.14's fixture: SPEC(#2270) → BUILD(#2287) → REVIEW(#2295), all merged. */
const ledgerChain = (buildOver: Partial<CondensedTimelineTask> = {}) =>
  chainOf(makeTask('spec', { title: '[spec] Ledger slice 2', latestWorker: memberWorker(2270) }), [
    makeTask('build', { title: '[build] Ledger slice 2', dependsOn: ['spec'], latestWorker: memberWorker(2287), ...buildOver }),
    makeTask('review', { title: '[review] Ledger slice 2', dependsOn: ['build'], latestWorker: memberWorker(2295) }),
  ]);

const railOfChain = (chain: ChainUnit<CondensedTimelineTask>, extra: Partial<CondensedTimelineProps> = {}) =>
  mobileTree(renderToStaticMarkup(
    <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chain] }} {...extra} />,
  ));

describe('CondensedTimeline — the chain row is a disclosure, never a link (§13.4)', () => {
  it('names the head in the title and the terminal member in the right column (AC-33, §11.14)', () => {
    const html = railOfChain(ledgerChain());

    expect(html).toContain('Ledger slice 2');
    expect(html).toContain('#2295');
    expect(html).not.toContain('#2270');
    expect(html).not.toContain('#2287');
  });

  it('puts no task link and no data-task-id on a row standing for three tasks (AC-34, Rule D1-7)', () => {
    const html = railOfChain(ledgerChain());
    const badge = html.indexOf('▣3');
    const line = rowAt(html, badge);

    expect(line).not.toContain('/app/tasks/');
    expect(line).not.toContain('data-task-id');
    // The only `<a>` on the line is the terminal PR — not a task link.
    expect(line).toContain('https://github.com/o/r/pull/2295');
  });

  it('leaves a tap anywhere in the chain toggle with no task to resolve (AC-35, Rule D13-14/D13-15)', () => {
    const html = railOfChain(ledgerChain());
    const toggle = controlAt(html, 'rail-chain-toggle');

    // `closest('[data-task-id]')` from anywhere inside the control finds nothing,
    // so the delegated handler cannot preventDefault or set `?task=` (D13-15).
    expect(enclosingTaskIds(html, toggle.start)).toEqual([]);
    expect(toggle.inner).not.toContain('data-task-id');
    // And there is no link under the finger either.
    expect(toggle.inner).not.toContain('<a ');
    expect(toggle.open).toContain('type="button"');
  });

  it('carries the badge and the title inside ONE button (Rule D13-17)', () => {
    const html = railOfChain(ledgerChain());
    const toggle = controlAt(html, 'rail-chain-toggle');

    expect(toggle.inner).toContain('▣3');
    expect(toggle.inner).toContain('Ledger slice 2');
    expect(toggle.open).toContain('aria-expanded="false"');
    // Rule D13-3: ≥44 CSS px wide, full row height.
    expect(toggle.open).toContain('self-stretch');
    expect(rowAt(html, html.indexOf('▣3'))).toContain('min-h-[24px]');
  });

  it('flips the badge glyph and opens the named member group when activated (AC-36, Rule D1-6)', () => {
    const html = railOfChain(ledgerChain(), { expandedChainIds: new Set(['spec']) });
    const toggle = controlAt(html, 'rail-chain-toggle');

    expect(toggle.open).toContain('aria-expanded="true"');
    expect(toggle.inner).toContain('▼3');
    expect(html).not.toContain('▣3');

    const controls = toggle.open.match(/aria-controls="([^"]*)"/)?.[1];
    expect(controls).toBeTruthy();
    const group = html.indexOf('data-testid="rail-chain-members"');
    expect(group).toBeGreaterThan(-1);
    expect(rowAt(html, group)).toBeTruthy();
    expect(html.slice(html.lastIndexOf('<', group), html.indexOf('>', group))).toContain(`id="${controls}"`);

    // Three ordinal sub-rows, each labelled from its own bracketed prefix.
    for (const label of ['SPEC', 'BUILD', 'REVIEW']) expect(html).toContain(`>${label} </span>`);
  });

  it('changes no OTHER chain row when one expands (AC-36, Rule D13-8)', () => {
    const second = chainOf(makeTask('s2', { title: '[spec] Ledger slice 3', latestWorker: memberWorker(2301) }), [
      makeTask('b2', { title: '[build] Ledger slice 3', dependsOn: ['s2'], latestWorker: memberWorker(2302) }),
    ]);
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [ledgerChain(), second] }}
        expandedChainIds={new Set(['spec'])}
      />,
    ));

    expect(html.match(/data-testid="rail-chain-toggle"/g)).toHaveLength(2);
    expect(html).toContain('▼3');
    expect(html).toContain('▣2');
    expect(html.match(/data-testid="rail-chain-members"/g)).toHaveLength(1);
  });

  it('sends each ordinal sub-row to its OWN task, never the head (AC-37, Rule D13-16)', () => {
    const html = railOfChain(ledgerChain(), { expandedChainIds: new Set(['spec']) });

    for (const id of ['spec', 'build', 'review']) {
      const href = html.indexOf(`href="/app/tasks/${id}"`);
      expect(href).toBeGreaterThan(-1);
      // The nearest `data-task-id` a tap on `2 BUILD` resolves to is BUILD.
      expect(enclosingTaskIds(html, href).at(-1)).toBe(id);
    }
    // Every task row opens the sheet the same way (AC-10): no opt-out attribute.
    expect(html).not.toContain('data-task-actionable');
  });

  it('keeps data-task-id off the unit wrapper and on the smallest single-task row (AC-38, Rule D13-13)', () => {
    const html = railOfChain(ledgerChain(), { expandedChainIds: new Set(['spec']) });

    const node = html.indexOf('data-rail-node');
    const nodeTag = html.slice(html.lastIndexOf('<', node), html.indexOf('>', node));
    expect(nodeTag).not.toContain('data-task-id');

    // No title link is ever enclosed by another task's id.
    for (const m of html.matchAll(/<a class="min-w-0 flex-1 truncate[^"]*" href="\/app\/tasks\/([^"]+)"/g)) {
      expect(enclosingTaskIds(html, m.index!).at(-1)).toBe(m[1]);
    }
  });

  it('still collapses at N=2, with the same badge and the same control (AC-43, §11.19)', () => {
    const two = chainOf(makeTask('spec', { title: '[spec] Ledger slice 3', latestWorker: memberWorker(2298) }), [
      makeTask('build', { title: '[build] Ledger slice 3', dependsOn: ['spec'], latestWorker: memberWorker(2301) }),
    ]);
    const html = railOfChain(two);

    expect(html).toContain('▣2');
    expect(html).toContain('data-testid="rail-chain-toggle"');
    expect(html).toContain('#2301');
    expect(html).not.toContain('#2298');
    expect(rowAt(html, html.indexOf('▣2'))).not.toContain('/app/tasks/');
  });
});

describe('CondensedTimeline — two disclosures on one unit (Rule D13-10, §11.16)', () => {
  const withMark = () => ledgerChain({
    reviewerNote: { type: 'reviewer_request_changes', title: 'Changes requested', body: null, status: 'open', supersededByPrNumber: null },
    attempts: strip({ parentTaskId: 'build' }),
  });

  it('moves the attempt control onto the member and folds the chain row\'s away (AC-41, Rule D13-17)', () => {
    const html = railOfChain(withMark(), { expandedChainIds: new Set(['spec']) });
    const chainLine = rowAt(html, html.indexOf('▼3'));

    // The chain row keeps the rolled-up mark as STATIC text …
    expect(chainLine).toContain('rail-outcome-mark');
    expect(chainLine).toContain('>!<');
    // … and offers no second control re-printing the members' own panels.
    expect(chainLine).not.toContain('rail-attempt-toggle');
    expect(chainLine.match(/aria-expanded/g)).toHaveLength(1);

    // Member 2 owns its history now.
    const memberLine = rowAt(html, html.indexOf('href="/app/tasks/build"'));
    expect(memberLine).toContain('rail-attempt-toggle');
    expect(memberLine).toContain('>!<');
  });

  it('keeps the chain row\'s own control while the chain is shut (AC-20, Rule D13-17)', () => {
    const html = railOfChain(withMark());
    const chainLine = rowAt(html, html.indexOf('▣3'));

    expect(chainLine).toContain('rail-attempt-toggle');
    expect(chainLine).toContain('>!<');
  });

  it('opens both and nests the panel between member 2 and member 3 (AC-42, §11.16)', () => {
    const html = railOfChain(withMark(), {
      expandedChainIds: new Set(['spec']),
      disclosedTaskIds: new Set(['build']),
    });

    // Exactly two open controls in the unit: the chain toggle and member 2's.
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="rail-chain-toggle"');
    expect(html).toContain('data-testid="rail-attempt-toggle"');

    const panel = html.indexOf('data-testid="rail-attempt-disclosure"');
    expect(panel).toBeGreaterThan(html.indexOf('href="/app/tasks/build"'));
    expect(panel).toBeLessThan(html.indexOf('href="/app/tasks/review"'));
    // A stray tap in the panel can only ever peek member 2.
    expect(enclosingTaskIds(html, panel)).toEqual(['build']);
  });
});

describe('CondensedTimeline — expansion is inert to layout (Rule D13-6, §11.17, §11.18)', () => {
  const friday = '2026-09-11T10:00:00.000Z';
  const saturday = '2026-09-12T10:00:00.000Z';
  const spanning = () =>
    chainOf(
      makeTask('spec', { title: '[spec] Ledger slice 2', taskUpdatedAt: friday, latestWorker: worker({ prNumber: 2270, prUrl: 'https://github.com/o/r/pull/2270', mergedAt: friday }) }),
      [
        makeTask('build', { title: '[build] Ledger slice 2', dependsOn: ['spec'], taskUpdatedAt: friday, latestWorker: worker({ prNumber: 2287, prUrl: 'https://github.com/o/r/pull/2287', mergedAt: friday }) }),
        makeTask('review', { title: '[review] Ledger slice 2', dependsOn: ['build'], taskUpdatedAt: saturday, latestWorker: worker({ prNumber: 2295, prUrl: 'https://github.com/o/r/pull/2295', mergedAt: saturday }) }),
      ],
    );

  it('emits no tick between two ordinal sub-rows of a day-spanning chain (AC-45, §11.17)', () => {
    const collapsed = railOfChain(spanning());
    const expanded = railOfChain(spanning(), { expandedChainIds: new Set(['spec']) });

    // Same ticks, same labels, collapsed or open.
    const ticks = (html: string) => [...html.matchAll(/data-testid="rail-tick"[\s\S]*?<\/div>/g)].map(m => m[0]);
    expect(ticks(expanded)).toEqual(ticks(collapsed));

    // And none of them falls inside the expanded member group.
    const group = expanded.indexOf('data-testid="rail-chain-members"');
    const afterGroup = expanded.indexOf('href="/app/tasks/review"');
    expect(expanded.slice(group, afterGroup)).not.toContain('rail-tick');
  });

  it('keeps the now tick and the goal root below the last ordinal sub-row (AC-46, §11.18)', () => {
    const extra = { railGoal: { total: 3, passed: 2 } };
    const collapsed = railOfChain(spanning(), extra);
    const expanded = railOfChain(spanning(), { ...extra, expandedChainIds: new Set(['spec']) });

    const lastOrdinal = expanded.indexOf('href="/app/tasks/review"');
    expect(lastOrdinal).toBeGreaterThan(-1);
    expect(expanded.indexOf('rail-goal-root')).toBeGreaterThan(lastOrdinal);
    // Neither the tick labels nor the pass count move.
    expect(expanded.match(/now · [A-Z][a-z]{2} \d+/g)).toEqual(collapsed.match(/now · [A-Z][a-z]{2} \d+/g));
    expect(expanded).toContain('2 / 3');
  });
});

describe('CondensedTimeline — Lane 2 is badge-free and stops its own taps (§11.20)', () => {
  const fanOut = (): ChainUnit<CondensedTimelineTask> => ({
    head: makeTask('head', { title: '[build] slice 3 dedupe index', status: 'running' }),
    tail: [
      makeTask('s1', { title: '[review] slice 3 dedupe index', status: 'pending', dependsOn: ['head'] }),
      makeTask('s2', { title: '[build] Backfill assertions', status: 'pending', dependsOn: ['head'] }),
      makeTask('s3', { title: '[build] Third sibling', status: 'pending', dependsOn: ['head'] }),
    ],
    shape: 'fan-out',
  });

  it('never renders a chain badge on a fan-out node (AC-44)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, running: [fanOut()] }} />,
    ));

    expect(html).not.toContain('▣');
    expect(html).not.toContain('▼');
    expect(html).not.toContain('rail-chain-toggle');
    expect(html).toContain('+1');
  });

  it('leaves the fork glyph with no task to resolve either (AC-47, Rule D13-14)', () => {
    const html = mobileTree(renderToStaticMarkup(
      <CondensedTimeline {...baseProps} groups={{ ...emptyGroups, running: [fanOut()] }} />,
    ));

    const fork = html.indexOf('├╮');
    expect(fork).toBeGreaterThan(-1);
    expect(enclosingTaskIds(html, fork)).toEqual([]);

    // Each sibling row, by contrast, names exactly itself (Rule D13-16).
    for (const id of ['s1', 's2']) {
      expect(enclosingTaskIds(html, html.indexOf(`href="/app/tasks/${id}"`)).at(-1)).toBe(id);
    }
    expect(enclosingTaskIds(html, html.indexOf('href="/app/tasks/head"')).at(-1)).toBe('head');
  });
});

describe('CondensedTimeline — expansion has exactly one writer (AC-40, Rule D13-18)', () => {
  const source = readFileSync(new URL('./CondensedTimeline.tsx', import.meta.url), 'utf8');

  it('never subscribes the rail to the router or an effect', () => {
    // The sheet's own `router.replace` re-renders this tree. Nothing in it may
    // read the address or fire on mount, or expansion would flip behind a sheet.
    expect(source).not.toContain('useSearchParams');
    expect(source).not.toContain('usePathname');
    expect(source).not.toContain('useEffect');
  });

  it('writes the chain expansion state only from the chain toggle\'s onClick', () => {
    // The rail's setter is uniquely named so this stays a mechanical check: the
    // file has other `setExpanded`s (desktop chain blocks, the footer) that are
    // nothing to do with a chain row.
    const writers = [...source.matchAll(/setChainExpanded\(/g)];
    expect(writers).toHaveLength(1);

    // …and that one call site is the `onToggle` the chain button fires.
    const before = source.slice(Math.max(0, writers[0].index! - 200), writers[0].index!);
    expect(before).toContain('onToggle');
  });

  it('reads the fixture seam only from a useState initializer', () => {
    const reads = [...source.matchAll(/expandedChainIds\?\./g)];
    expect(reads).toHaveLength(1);
    expect(source.slice(Math.max(0, reads[0].index! - 60), reads[0].index!)).toContain('useState(');
  });
});

// ─── v3.1: the goal root and criteria evaluators (§5, §11.21) ────────────────

describe('CondensedTimeline — the goal root reads verdicts, not evaluators (§5)', () => {
  const evaluator = (over: Partial<BookkeepingTask> = {}): BookkeepingTask => ({
    id: 'eval-1',
    title: 'Verify goal criterion: tests green',
    taskUpdatedAt: '2026-09-11T11:00:00.000Z',
    latestWorker: null,
    ...over,
  });

  const withEvaluator = (tasks: BookkeepingTask[], passed: number | null = 1) =>
    mobileTree(renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [chainOf(makeTask('gate', { title: 'Wire the §4 delta gate', latestWorker: memberWorker(2289) }))] }}
        railGoal={{ total: 3, passed }}
        bookkeepingTasks={tasks}
      />,
    ));

  it('keeps a running evaluator off the rail and below the root (AC-48, §11.21a)', () => {
    const html = withEvaluator([evaluator()]);

    // The root is the rail's last element; the footer follows it and is not
    // part of the rail. The evaluator is reachable there and only there.
    const root = html.indexOf('data-testid="rail-goal-root"');
    const footer = html.indexOf('orchestrator run');
    expect(root).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(root);

    // Not a node, not an ordinal sub-row, not a Lane-2 sibling — whatever its
    // status, a `bookkeeping` task never reaches the rail at all.
    expect(html).not.toContain('data-task-id="eval-1"');
    expect(html).not.toContain('href="/app/tasks/eval-1"');
    expect(html.slice(0, root)).not.toContain('Verify goal criterion');
    expect(html.match(/data-rail-node/g)).toHaveLength(1);
    expect(html).toContain('goal ');
    expect(html).toContain('1 / 3');
  });

  it('counts only `pass`, and never degrades an evaluated count to ? (AC-49, Rule D5-7)', () => {
    // Stored verdicts pass / PENDING / fail → 1 of 3, hollow square, no `?`.
    const html = withEvaluator([evaluator()], 1);

    expect(html).toContain('1 / 3');
    expect(html).not.toContain('? / 3');
    // Hollow, because `passed < total` — a `completed` evaluator proves nothing.
    const root = html.indexOf('data-testid="rail-goal-root"');
    expect(html.slice(root, root + 400)).not.toContain('bg-current');
  });

  it('spends no ✗ on an evaluator that died and was re-claimed (AC-50, §11.21b)', () => {
    const html = withEvaluator([
      evaluator(),
      evaluator({ id: 'eval-2' }),
    ], 1);

    expect(html).not.toContain('✗');
    expect(html).not.toContain('rail-attempt-toggle');
    expect(html).toContain('1 / 3');
  });
});

// ─── mission-legibility.md §4 — phase headers and the work-kind glyph ───────

describe('CondensedTimeline — mission phase headers (§4.2)', () => {
  it('renders a header for a phased task and suppresses day ticks (AC-6)', () => {
    const a = makeTask('a', {
      missionPhaseIndex: 1,
      missionPhaseLabel: 'Storage',
      taskUpdatedAt: '2026-09-08T09:00:00.000Z',
      latestWorker: {
        id: 'w', status: 'completed', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1,
        prLifecycleStatus: 'merged', mergedAt: '2026-09-08T09:00:00.000Z', completedAt: null,
        startedAt: null, currentAction: null, branch: null, waitingFor: null,
      },
    });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(a)] }} />),
    );

    expect(html).toContain('rail-phase-header');
    expect(html).toContain('1 · Storage');
    expect(html).not.toContain('data-testid="rail-tick"');
  });

  it('renders no phase header for a mission where no task carries a phase (AC-1)', () => {
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))] }} />),
    );
    expect(html).not.toContain('rail-phase-header');
  });

  it('a phase header carries no interactive element (AC-22)', () => {
    const a = makeTask('a', { missionPhaseIndex: 1, missionPhaseLabel: 'Storage' });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(a)] }} />),
    );
    const headerStart = html.indexOf('rail-phase-header');
    const headerHtml = html.slice(headerStart, headerStart + 600);
    expect(headerHtml).not.toContain('<button');
    expect(headerHtml).not.toContain('<a ');
    expect(headerHtml).not.toContain('aria-expanded');
  });
});

describe('CondensedTimeline — work-kind glyph column (§4.4)', () => {
  it('renders the declared kind glyph for a node (Rule R4-11)', () => {
    const a = makeTask('a', { kind: 'engineering' });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(a)] }} />),
    );
    expect(html).toContain('◆');
  });

  it('renders the glyph outside the title link, aria-hidden, at most once per row (AC-8/R4-12)', () => {
    const a = makeTask('a', { kind: 'engineering' });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(a)] }} />),
    );
    expect((html.match(/◆/g) ?? []).length).toBe(1);
    const glyphIdx = html.indexOf('◆');
    const linkIdx = html.indexOf('/app/tasks/a');
    // The glyph span (aria-hidden, sibling) renders before the title link opens.
    expect(glyphIdx).toBeLessThan(linkIdx);
    const glyphSpanStart = html.lastIndexOf('<span', glyphIdx);
    expect(html.slice(glyphSpanStart, glyphIdx)).toContain('aria-hidden="true"');
  });

  it('renders no glyph and no spacer for a title-only task with nothing set (AC-9 — the title trap)', () => {
    const a = makeTask('a', { title: 'BUILD: rewrite the claim loop' });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(a)] }} />),
    );
    // No column reserved anywhere on the rail — this mission has no kinds at all.
    expect(html).not.toContain('w-[18px]');
  });

  it('reserves the glyph column for every row once any node in the rail has a kind (Rule R4-19)', () => {
    const withKind = makeTask('a', { kind: 'engineering' });
    const withoutKind = makeTask('b', { title: 'BUILD: no kind here' });
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chainOf(withKind)], nextQueued: [chainOf(withoutKind, [], )] }}
        />,
      ),
    );
    expect((html.match(/w-\[18px\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('shows the collapsed chain head glyph, not a tail member glyph (Rule R4-13)', () => {
    const head = makeTask('spec', { kind: 'research' });
    const tail = makeTask('build', { kind: 'engineering', dependsOn: ['spec'] });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(head, [tail])] }} />),
    );
    // Collapsed: only the head's glyph (◇ research) appears before expansion.
    expect(html).toContain('◇');
    expect(html).not.toContain('◆');
  });
});
