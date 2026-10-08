/**
 * AC-12/AC-13 (docs/design/mission-feed-mobile-continuity.md W6): the full task
 * page for a mission task carries the mission — chip, context pulse ringed on
 * this task, `n / N · PHASE`, ‹ › to its pulse-order siblings' pages, and an
 * up-link that lands on the task's own row (`#t-<id>`).
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionCardView, toFeedTask, type MissionCardRow, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { deriveDeliveryView } from '@/lib/workflow/projections';
import { feedStripOrder } from '@/lib/mission-strip-order';
import { buildPulseSegments } from '@/lib/mission-pulse';
import { buildMissionContextBar, missionContextBarFor } from './mission-context-bar';

let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const THINK = { missionPhaseIndex: 0, missionPhaseLabel: 'THINK' };
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };

function mission(tasks: MissionCardTaskRow[]): MissionCardRow {
  return { id: 'm1', title: 'Claim loop hardening', status: 'active', orchestrationMode: 'auto', tasks };
}

const tasks = [
  t('b1', { ...BUILD, status: 'completed' }),
  t('a1', { ...THINK, status: 'completed' }),
  t('b2', { ...BUILD, status: 'in_progress', workers: [{ status: 'running' }] }),
  t('b2-r1', { taskClass: 'attempt', parentTaskId: 'b2', status: 'failed' }),
  t('b3', { ...BUILD }),
  t('orch', { taskClass: 'bookkeeping', title: 'Plan the mission' }),
];

describe('buildMissionContextBar', () => {
  it('numbers the task in pulse order (phase order, not creation order) and names its phase', () => {
    const bar = buildMissionContextBar(mission(tasks), 'b2');
    // THINK a1 comes first even though b1 was created first.
    expect(bar.position).toEqual(expect.objectContaining({ n: 3, total: 4, phaseLabel: '2 BUILD' }));
  });

  it('‹ › link to the pulse-order siblings’ full pages, keeping the mission context', () => {
    const bar = buildMissionContextBar(mission(tasks), 'b2');
    expect(bar.position?.prevHref).toBe('/app/tasks/b1?from=mission&missionId=m1');
    expect(bar.position?.nextHref).toBe('/app/tasks/b3?from=mission&missionId=m1');
  });

  it('the ends of the pulse have no sibling link', () => {
    expect(buildMissionContextBar(mission(tasks), 'a1').position?.prevHref).toBeNull();
    expect(buildMissionContextBar(mission(tasks), 'b3').position?.nextHref).toBeNull();
  });

  it('the up-link lands on the task’s own row (AC-12)', () => {
    expect(buildMissionContextBar(mission(tasks), 'b2').upHref).toBe('/app/missions/m1#t-b2');
  });

  it('the pulse is the same builder output every surface draws, ringed on this task', () => {
    const bar = buildMissionContextBar(mission(tasks), 'b2');
    // Dependency-first strip order (#3775): same ids, same order as every other surface.
    const feed = tasks.map(toFeedTask);
    expect(bar.segments.map(s => s.taskId)).toEqual(
      buildPulseSegments(feed, { order: feedStripOrder(feed) }).map(s => s.taskId),
    );
    expect([...bar.segments.map(s => s.taskId)].sort()).toEqual(['a1', 'b1', 'b2', 'b3']);
    expect(bar.selectedTaskId).toBe('b2');
  });

  it('an attempt sits at its parent’s position and returns to the parent’s row', () => {
    const bar = buildMissionContextBar(mission(tasks), 'b2-r1');
    expect(bar.selectedTaskId).toBe('b2');
    expect(bar.position?.n).toBe(3);
    expect(bar.upHref).toBe('/app/missions/m1#t-b2');
  });

  it('a bookkeeping task has no position but still links back to the mission', () => {
    const bar = buildMissionContextBar(mission(tasks), 'orch');
    expect(bar.position).toBeNull();
    expect(bar.selectedTaskId).toBeNull();
    expect(bar.upHref).toBe('/app/missions/m1#t-orch');
  });

  it('carries the mission title and the one state chip (D2)', () => {
    const bar = buildMissionContextBar(mission(tasks), 'b2');
    expect(bar.title).toBe('Claim loop hardening');
    expect(bar.chip.label).toBe('RUNNING');
    expect(bar.missionId).toBe('m1');
  });
});

describe('missionContextBarFor — the page gate (AC-13: absent for non-mission tasks)', () => {
  it('returns no bar for a task with no mission row', () => {
    expect(missionContextBarFor(null, 'b2')).toBeNull();
    expect(missionContextBarFor(undefined, 'b2')).toBeNull();
  });

  it('returns the same bar the builder does for a mission task', () => {
    expect(missionContextBarFor(mission(tasks), 'b2')).toEqual(buildMissionContextBar(mission(tasks), 'b2'));
  });
});

describe('S35: the bar\'s chip reads the kernel delivery, as the mission card does', () => {
  it('a failed fix whose delivery is still live does not turn the chip FAILED', () => {
    const row = mission([t('own', { status: 'completed' }), t('fix1', { status: 'failed' }), t('fix2')]);
    const v = deriveDeliveryView({
      view: {
        delivery: {
          id: 'd1', workspaceId: 'w1', ownerTaskId: 'own', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
          state: 'CHANGES_REQUESTED', stateReason: null, version: 3, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
          boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
          compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
          mergeCommitSha: null, supersededByPr: null,
        },
        rounds: [], attempts: [],
      },
      attemptTasks: [
        { taskId: 'own', role: 'owner', status: 'completed', createdAt: '2026-10-06T00:00:00Z' },
        { taskId: 'fix1', role: 'fix', status: 'failed', createdAt: '2026-10-06T01:00:00Z' },
        { taskId: 'fix2', role: 'fix', status: 'pending', createdAt: '2026-10-06T02:00:00Z' },
      ],
    })!;
    const views = new Map([['own', v], ['fix1', v], ['fix2', v]]);
    const withViews = missionContextBarFor(row, 'fix2', views)!;
    expect(withViews.chip).toEqual(buildMissionCardView(row, { from: 'missions', deliveryViews: views }).chip);
    expect(withViews.chip).not.toEqual(missionContextBarFor(row, 'fix2')!.chip);
  });
});
