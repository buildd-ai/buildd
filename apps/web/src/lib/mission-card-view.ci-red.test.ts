/**
 * A mission card whose PR is red after the CI-fix chain has ended: the card
 * says so and renders as blocked, not READY FOR REVIEW. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionCardView, summarizeMissionForCard, type MissionCardRow, type MissionCardTaskRow } from './mission-card-view';

const NOW = Date.now();
let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'completed', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
const PR = 'https://example.invalid/pull/12';
const ownerWorker = (lifecycle: string) => ({ status: 'completed', prNumber: 12, prUrl: PR, prLifecycleStatus: lifecycle });
const fixTask = (n: number, status = 'completed') =>
  task(`fix-${n}`, {
    status,
    taskClass: 'attempt',
    parentTaskId: 'owner',
    title: `[builder · after CI #${n}] Task owner`,
    workers: [{ status: 'completed', prNumber: 12, prUrl: PR, prLifecycleStatus: null }],
  });
const mission = (tasks: MissionCardTaskRow[]): MissionCardRow =>
  ({ id: 'm1', title: 'Ship it', status: 'active', isHeld: false, tasks });
const view = (row: MissionCardRow) => buildMissionCardView(row, { from: 'missions', now: NOW });

describe('a red PR after the CI-fix chain ended', () => {
  it('renders as blocked and names the attempts, not READY FOR REVIEW', () => {
    const row = mission([
      task('owner', { workers: [ownerWorker('ci_failed')] }),
      fixTask(1), fixTask(2), fixTask(3),
    ]);
    const v = view(row);
    expect(v.chip.label).toBe('BLOCKED');
    expect(v.chip.label).not.toBe('READY FOR REVIEW');
    expect(summarizeMissionForCard(row, { now: NOW }).state.situation.headline).toContain('CI red after 3 fix attempts');
  });

  it('a red PR with no fix attempt keeps the ordinary reading', () => {
    const v = view(mission([task('owner', { workers: [ownerWorker('ci_failed')] })]));
    expect(v.chip.label).toBe('READY FOR REVIEW');
  });

  it('a fix still open is not an exhausted chain', () => {
    const v = view(mission([
      task('owner', { workers: [ownerWorker('ci_failed')] }),
      fixTask(1, 'pending'),
    ]));
    expect(v.chip.label).not.toBe('BLOCKED');
  });
});
