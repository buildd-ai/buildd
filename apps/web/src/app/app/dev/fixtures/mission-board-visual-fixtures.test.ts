import { describe, expect, it } from 'bun:test';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { FIXTURE_VIEWS, isFixtureView } from './visual-review-fixtures';
import {
  MISSION_BOARD_VISUAL_STATE,
  missionBoardVisualFixture,
  missionBoardVisualLinks,
  parseMissionBoardVisualParams,
} from './mission-board-visual-fixtures';

/**
 * `?state=mission-board-visual` renders the real Board, Lanes and Feed with a
 * visual model. Illustrative data only; decisions stay in memory.
 */
describe('mission board visual fixture', () => {
  it('is a fixture view', () => {
    expect(FIXTURE_VIEWS).toContain(MISSION_BOARD_VISUAL_STATE);
    expect(isFixtureView(MISSION_BOARD_VISUAL_STATE)).toBe(true);
  });

  it('parses phase, reason, layout and complete, falling back on unknown values', () => {
    expect(parseMissionBoardVisualParams(new URLSearchParams(''))).toMatchObject({ phase: 'needs_you', layout: 'board', complete: false, options: { needsYou: 'unsure' } });
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=capturing&layout=feed'))).toMatchObject({ phase: 'capturing', layout: 'feed' });
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=off&layout=nope'))).toMatchObject({ phase: 'needs_you', layout: 'board' });
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=reviewed&complete=1')).complete).toBe(true);
    // The audit task's own surfaces (task sheet and task page), e.g. before its first screen.
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=no_browser_runner&layout=task'))).toMatchObject({ phase: 'no_browser_runner', layout: 'task' });
  });

  it('parses the What shipped header variant, only for a completed mission', () => {
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=reviewed&complete=1&shipped=noshots')).shipped).toBe('noshots');
    expect(parseMissionBoardVisualParams(new URLSearchParams('phase=reviewed&shipped=lede')).shipped).toBeNull();
    expect(parseMissionBoardVisualParams(new URLSearchParams('complete=1&shipped=nope')).shipped).toBeNull();
  });

  it('every linked state puts the audit on the board, under its own id', () => {
    for (const l of missionBoardVisualLinks()) {
      const p = parseMissionBoardVisualParams(new URLSearchParams(l.href.slice(1)));
      const visual = buildVisualReviewFixtureModel(p.phase, p.options);
      expect(visual.phase).toBe(p.phase);
      const board = missionBoardVisualFixture(visual, { complete: p.complete });
      const auditId = visual.audit!.id;
      expect(board.phases.some(ph => ph.taskIds.includes(auditId))).toBe(true);
      expect(board.tasks[auditId].roleSlug).toBe('visual-auditor');
    }
  });

  it('a parked audit is a Needs-you ask on the board, as on a real mission', () => {
    const visual = buildVisualReviewFixtureModel('boot_failed');
    const board = missionBoardVisualFixture(visual);
    expect(board.needsYou).toEqual([visual.audit!.id]);
  });
});
