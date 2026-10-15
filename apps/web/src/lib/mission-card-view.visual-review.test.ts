// Spec 8e137fdb I-1: the Home card reads the visual review and its hold the
// way the mission header does (b4ea396b follow-up 1), and names an open
// required check before the all-clear (AC-7).
import { describe, expect, it } from 'bun:test';
import { summarizeMissionForCard, type MissionCardRow, type MissionCardTaskRow } from './mission-card-view';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000);

const built = (id: string, pr: number): MissionCardTaskRow => ({
  id, title: `feat: ${id}`, status: 'completed', taskClass: 'work', mode: 'execution', createdAt: ago(300),
  workers: [{ status: 'completed', startedAt: ago(290), completedAt: ago(200), updatedAt: ago(200), prNumber: pr, prUrl: `https://example.invalid/pr/${pr}`, mergedAt: ago(190) } as never],
});
const missionPr: MissionCardTaskRow = {
  id: 'mpr', title: 'Ship mission: Example', status: 'completed', taskClass: 'bookkeeping', mode: 'execution', createdAt: ago(180),
  workers: [{ status: 'completed', startedAt: ago(180), completedAt: ago(100), updatedAt: ago(100), prNumber: 90, prUrl: 'https://example.invalid/pr/90', mergedAt: ago(100) } as never],
};
const audit: MissionCardTaskRow = {
  id: 'aud', title: '[surface audit] Example', status: 'pending', taskClass: 'work', mode: 'execution', createdAt: ago(90), workers: [],
};
const row = (over: Partial<MissionCardRow> = {}): MissionCardRow => ({
  id: 'm1', title: 'Example', status: 'active', executor: 'runner', workspaceId: 'ws',
  integrationBranchEnabled: true, workingBranch: 'mission/example',
  tasks: [built('a', 1), built('b', 2), missionPr, audit],
  ...over,
});

describe('Home card agrees with the header on the visual review', () => {
  it('a blocked review reads unable to run with its cause, as the header does', () => {
    const s = summarizeMissionForCard(row(), { now: NOW, visualReview: { status: 'blocked', blockedDetail: 'it needs a runner with a browser', holdReason: null } });
    expect(s.state.chip.label).toBe('VISUAL REVIEW UNABLE TO RUN');
    expect(s.state.situation?.headline).toContain('it needs a runner with a browser');
  });

  it('a queued review names the hold the review state carries', () => {
    const s = summarizeMissionForCard(row(), { now: NOW, visualReview: { status: 'queued', blockedDetail: null, holdReason: 'budget_paused' } });
    expect(s.state.chip.label).toBe('VISUAL REVIEW QUEUED');
    expect(s.state.situation?.headline).toContain('runners paused new work until the model budget resets');
  });

  it('an unchecked required criterion is named before the all-clear', () => {
    const r = row({
      tasks: [built('a', 1), built('b', 2), missionPr],
      goalCriteria: [{ type: 'description', description: 'Admin audit log spec holds', label: 'Admin audit log spec', notMechanizableReason: 'judged by reading' }],
      goalCriteriaState: null,
    });
    const s = summarizeMissionForCard(r, { now: NOW });
    expect(s.state.chip.label).not.toBe('READY TO COMPLETE');
  });
});
