/**
 * The mission page's feed derivation (`buildMissionFeedView`) and the page's
 * wiring of it. The view-level tests render `MissionDetailView` with
 * hand-built props, so without these the page could stop passing the feed,
 * pass a different task set to the pulse and the sheet, or go back to the
 * first-wins reviewer-retry loop (AC-21) and nothing would fail.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPulseSegments } from '@/lib/mission-pulse';
import { buildMissionFeedView } from './mission-feed-view';

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

  it('passes the same feedTasks to the sheet owner and to the list', () => {
    expect(src).toMatch(/<TaskPanelWrapper[\s\S]*?feedTasks=\{feedTasks\}/);
    expect(src).toMatch(/feed=\{\{\s*tasks: feedTasks,/);
    expect(src).toMatch(/segments=\{pulseSegments\}/);
  });

  it('links the Verified delivery step to the criteria sheet only when the page renders its target', () => {
    expect(src).toMatch(/verified: criteriaReachable \? \(\s*<a\s+href=\{`#\$\{MISSION_CRITERIA_ANCHOR\}`\}/);
    expect(src).toMatch(/criteriaReachable=\{criteriaReachable\}/);
  });

  it('feeds the Shipped step this mission\'s own trunk merges (D6)', () => {
    expect(src).toMatch(/mergedAt: missionTrunkMergedAt\(/);
  });

  it('keeps the newest reviewer retry via buildReviewerRetryMap (AC-21), not a first-wins loop', () => {
    expect(src).toMatch(/buildReviewerRetryMap\(/);
    expect(src).not.toMatch(/reviewerRetryMap\.has\(/);
  });
});
