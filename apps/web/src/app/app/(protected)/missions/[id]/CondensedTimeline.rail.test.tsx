/**
 * The mobile rail is retired (docs/design/mission-feed-mobile-continuity.md,
 * slice S3; docs/specs/timeline-mobile-rail.md is superseded by
 * docs/specs/mission-feed.md). Below md the mission page renders
 * `MissionFeedList` — one list, one classifier — and `CondensedTimeline` is
 * the md-and-up Timeline only.
 *
 * What survives from the rail's acceptance criteria is the desktop half: the
 * six-section list with day banding (AC-8), untouched by rail markup.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
};

const RAIL_MARKUP = [
  'data-testid="mission-rail"',
  'rail-tick',
  'rail-goal-root',
  'rail-phase-header',
  'rail-attempt-toggle',
  'rail-chain-toggle',
  'rail-outcome-mark',
  '▣',
];

describe('CondensedTimeline — the mobile rail is retired', () => {
  it('renders no rail markup for any mission shape', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        allTasksCount={3}
        groups={{
          ...emptyGroups,
          done: [chainOf(makeTask('spec'), [makeTask('build', { dependsOn: ['spec'] })])],
          failed: [chainOf(makeTask('f', { status: 'failed' }))],
          nextQueued: [chainOf(makeTask('q', { status: 'pending', missionPhaseIndex: 0, missionPhaseLabel: 'BUILD' }))],
        }}
      />,
    );
    for (const mark of RAIL_MARKUP) expect(html).not.toContain(mark);
    expect(html).not.toContain('md:hidden');
  });

  it('keeps the md+ tree on the six-section list with day banding (rail AC-8)', () => {
    const html = renderToStaticMarkup(
      <CondensedTimeline
        {...baseProps}
        groups={{ ...emptyGroups, done: [chainOf(makeTask('a'))], nextQueued: [chainOf(makeTask('q', { status: 'pending' }))] }}
      />,
    );
    expect(html).toContain('hidden md:block');
    expect(html).toContain('Next queued');
  });

  it('keeps the rail and its seams out of the component source', () => {
    const src = readFileSync(join(import.meta.dir, 'CondensedTimeline.tsx'), 'utf8');
    for (const name of ['MobileRail', 'RailNodeRow', 'buildRail', 'disclosedTaskIds', 'expandedChainIds', 'railGoal']) {
      expect(src).not.toContain(name);
    }
  });
});
