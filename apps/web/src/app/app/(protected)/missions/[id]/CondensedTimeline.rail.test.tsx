/**
 * Mobile rail render branch — docs/specs/timeline-mobile-rail.md acceptance
 * criteria that are about markup rather than the pure model (which
 * `lib/condensed-timeline-rail.test.ts` covers).
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CondensedTimeline from './CondensedTimeline';
import type { CondensedTimelineProps, CondensedTimelineTask } from './CondensedTimeline';
import type { ChainUnit } from '@/lib/condensed-timeline';

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

  it('keeps a retry off the ordinal count and renders it as a red stub (AC-3)', () => {
    const chain = chainOf(makeTask('spec'), [makeTask('build', { dependsOn: ['spec'] })]);
    const retry = chainOf(makeTask('build-retry', { status: 'failed' }));
    const html = mobileTree(
      renderToStaticMarkup(
        <CondensedTimeline
          {...baseProps}
          groups={{ ...emptyGroups, done: [chain], failed: [retry] }}
          retryLinks={new Map([['build-retry', 'build']])}
        />,
      ),
    );

    expect(html).toContain('▣2');
    expect(html).toContain('border-status-error');
    expect(html).toContain('✗');
    expect(html).not.toContain('▣3');
  });

  it('replaces the collapsed attempt summary line with the stub (Rule D3-5)', () => {
    const task = makeTask('t', {
      attempts: {
        parentTaskId: 't',
        total: 2,
        dots: '●●',
        summary: '2 attempts · CI ×1',
        kindCounts: {} as never,
        attempts: [],
      },
    });
    const html = mobileTree(
      renderToStaticMarkup(<CondensedTimeline {...baseProps} groups={{ ...emptyGroups, done: [chainOf(task)] }} />),
    );

    expect(html).toContain('rail-retry-stub');
    // The always-visible `●● 2 attempts · CI ×1` row is what the stub replaces.
    expect(html).not.toContain('2 attempts · CI ×1');
    expect(html).not.toContain('●●');
  });

  it('renders the rail even with an empty mission, without empty chrome', () => {
    const html = mobileTree(renderToStaticMarkup(<CondensedTimeline {...baseProps} />));
    expect(html).toContain('No tasks yet');
    expect(html).not.toContain('rail-tick');
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
