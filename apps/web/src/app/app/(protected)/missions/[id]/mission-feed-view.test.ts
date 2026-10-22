/**
 * The mission page's feed derivation (`buildMissionFeedView`) and the page's
 * wiring of it. The view-level tests render `MissionDetailView` with
 * hand-built props, so without these the page could stop passing the feed,
 * pass a different task set to the pulse and the list, or go back to the
 * first-wins reviewer-retry loop (AC-21) and nothing would fail.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPulseSegments } from '@/lib/mission-pulse';
import { buildMissionFeedView, toMissionFeedTaskInput } from './mission-feed-view';

const t = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Example ${id}`,
  status: 'pending',
  taskClass: 'work',
  createdAt: new Date(Date.UTC(2026, 0, 1, 9, Number(id.replace(/\D/g, '') || 0))),
  workers: [] as unknown[],
  ...over,
});

const LIVE = new Set(['running', 'waiting_input']);

describe('buildMissionFeedView', () => {
  const tasks = [
    t('w1', { status: 'completed', workers: [{ status: 'completed', artifacts: [{ type: 'report', visibility: 'public' }, { type: 'log' }] }] }),
    t('w2', { status: 'in_progress', workers: [{ status: 'running', currentAction: 'editing a file' }] }),
    t('w3'),
    t('a1', { taskClass: 'attempt', parentTaskId: 'w2' }),
    t('bk', { taskClass: 'bookkeeping', mode: 'planning' }),
  ];
  const view = buildMissionFeedView(tasks, { activeAgents: 1, liveStatuses: LIVE });

  it('keeps every task in the feed input; the builders fold attempts and bookkeeping', () => {
    expect(view.feedTasks.map(f => f.id)).toEqual(['w1', 'w2', 'w3', 'a1', 'bk']);
  });

  it('builds the pulse from that same feed input', () => {
    expect(view.pulseSegments).toEqual(buildPulseSegments(view.feedTasks));
    expect(view.pulseSegments.map(s => s.taskId)).toEqual(['w1', 'w2', 'w3']);
  });

  it('captions done/total and live workers', () => {
    expect(view.pulseCaption).toBe('1/3 · 1 live');
  });

  it('counts review-worthy records only, and names the live action of a moving task', () => {
    expect(view.recordsCountByTask).toEqual({ w1: 1 });
    expect(view.liveLines).toEqual({ w2: 'editing a file' });
  });

  it('labels every segment with its task title', () => {
    expect(view.segmentLabels.w2).toBe('Example w2');
  });
});

describe('mission page wiring (source shape)', () => {
  const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

  it('derives the feed once, through buildMissionFeedView', () => {
    expect(src.match(/buildMissionFeedView\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/buildPulseSegments\(/);
    expect(src).not.toMatch(/\.map\(toMissionFeedTaskInput\)/);
  });

  it('mounts no task sheet: ?task= redirects to the task page, #t- lands through the focus store (spec d25d923d)', () => {
    expect(src).not.toMatch(/TaskPanelWrapper|<TaskSheet|from '\.\/TaskSheet'/);
    expect(src).toMatch(/const taskPage = legacyTaskSheetRedirect\(id, search\);\s*if \(taskPage\) redirect\(taskPage\);/);
    expect(src).toMatch(/<MissionFocusProvider missionId=\{id\}>/);
  });

  it('every layout reads the one board model: Overview, Flow and History', () => {
    expect(src).toMatch(/<MissionOverview model=\{boardModel\}/);
    expect(src).toMatch(/<FlowTimeline model=\{boardModel\}/);
    expect(src).toMatch(/<MissionFeedLayout\s+model=\{boardModel\}/);
    expect(src).toMatch(/criteriaReachable=\{criteriaReachable\}/);
  });

  it('feeds the Shipped step this mission\'s own trunk merges (D6)', () => {
    expect(src).toMatch(/const missionMergedAt = missionTrunkMergedAt\(/);
    expect(src).toMatch(/mergedAt: missionMergedAt,/);
    // P-3: the release status reads the same merges.
    expect(src).toMatch(/missionReleaseStatus\(\{[\s\S]*?mergedAt: missionMergedAt/);
  });

  it('builds no chain grouping for a graph it no longer draws (Flow replaced Structure)', () => {
    expect(src).not.toMatch(/groupChainUnits\(/);
    expect(src).not.toMatch(/reviewerRetryMap\.has\(/);
    expect(src).not.toMatch(/StructureView|MissionLanes/);
  });
});

describe('toMissionFeedTaskInput', () => {
  it('keeps only what the feed model reads, with the latest worker', () => {
    const input = toMissionFeedTaskInput({
      id: 'a', title: 'A', status: 'in_progress', createdAt: '2026-01-01T00:00:00Z', taskClass: 'work',
      missionPhaseIndex: 1, missionPhaseLabel: 'BUILD', dependsOn: ['z'], roleSlug: 'builder',
      result: { summary: 'large payload' }, context: { big: true },
      workers: [
        { status: 'running', prNumber: 7, prUrl: 'https://example.invalid/pr/7', startedAt: '2026-01-01T00:01:00Z', artifacts: [{ content: 'x' }] },
        { status: 'failed' },
      ],
    });
    expect(input).toEqual({
      id: 'a', title: 'A', status: 'in_progress', createdAt: '2026-01-01T00:00:00Z', updatedAt: null,
      taskClass: 'work', parentTaskId: null, mode: null, kind: null, roleSlug: 'builder', category: null,
      creationSource: null, dependsOn: ['z'], missionPhaseIndex: 1, missionPhaseLabel: 'BUILD',
      worker: {
        status: 'running', startedAt: '2026-01-01T00:01:00Z', updatedAt: null, prNumber: 7,
        prUrl: 'https://example.invalid/pr/7', prLifecycleStatus: null, mergedAt: null,
      },
    });
  });

  it('a task that never ran has a null worker', () => {
    expect(toMissionFeedTaskInput({ id: 'a', title: 'A', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }).worker).toBeNull();
  });
});
