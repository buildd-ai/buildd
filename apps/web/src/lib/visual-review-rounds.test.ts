import { describe, expect, it } from 'bun:test';
import { buildVisualReviewFixtureModel } from './visual-review-model.fixtures';
import { visualReviewForRound, visualReviewRoundGroups, visualReviewRoundOf, visualReviewRounds } from './visual-review-rounds';

// The two-round fixture: round 1 shot seven screens, round 2 re-shot one.
const model = () => buildVisualReviewFixtureModel('reviewed');

describe('visualReviewRounds', () => {
  it('lists the rounds that shot a screen, latest first', () => {
    expect(visualReviewRounds(model())).toEqual([2, 1]);
  });

  it('is empty with no screens', () => {
    expect(visualReviewRounds(buildVisualReviewFixtureModel('queued'))).toEqual([]);
  });
});

describe('visualReviewRoundOf', () => {
  it('reads an audit task\'s round from the shots it wrote', () => {
    expect(visualReviewRoundOf(model(), 'fixture-audit-1')).toBe(1);
    expect(visualReviewRoundOf(model(), 'fixture-audit-2')).toBe(2);
  });

  it('falls back to the latest audit\'s round for the latest audit with no shots yet', () => {
    const m = buildVisualReviewFixtureModel('queued');
    expect(visualReviewRoundOf(m, m.audit!.id)).toBe(m.audit!.round);
  });

  it('is null for a task that is not an audit of this mission', () => {
    expect(visualReviewRoundOf(model(), 'some-other-task')).toBeNull();
  });
});

describe('visualReviewForRound', () => {
  it('round 2 holds only the screen round 2 re-shot, with its round-2 entry current', () => {
    const r2 = visualReviewForRound(model(), 2);
    expect(r2.cells.map(c => c.key)).toEqual(['/app/tasks/:id|mobile|']);
    expect(r2.cells[0].current.round).toBe(2);
    expect(r2.summary.shots).toBe(1);
    expect(r2.queue).toEqual(['/app/tasks/:id|mobile|']);
  });

  it('round 1 shows the round-1 shots, never a later round\'s', () => {
    const r1 = visualReviewForRound(model(), 1);
    expect(r1.cells.length).toBe(7);
    expect(r1.cells.every(c => c.current.round === 1)).toBe(true);
    expect(r1.cells.every(c => c.history.every(h => h.round <= 1))).toBe(true);
    // The re-shot cell shows round 1's issue verdict here.
    const fixed = r1.cells.find(c => c.key === '/app/tasks/:id|mobile|')!;
    expect(fixed.current.agentVerdict).toBe('issue');
  });

  it('an earlier round reads as reviewed history, not the audit\'s live phase', () => {
    const live = buildVisualReviewFixtureModel('needs_you', { needsYou: 'unsure', scenario: 'deck' });
    const rounds = visualReviewRounds(live);
    if (rounds.length > 1) {
      expect(visualReviewForRound(live, rounds[rounds.length - 1]).phase).toBe('reviewed');
    }
    // The latest round keeps the live phase.
    expect(visualReviewForRound(live, rounds[0]).phase).toBe(live.phase);
  });

  it('recounts the summary from the round\'s cells', () => {
    const r1 = visualReviewForRound(model(), 1);
    expect(r1.summary.ok + r1.summary.issues + r1.summary.unsure).toBe(r1.summary.shots);
    expect(r1.summary.awaitingHuman).toBe(r1.cells.filter(c => c.needsHuman).length);
    expect(r1.summary.reviewed + r1.summary.unreviewed).toBe(r1.summary.shots);
  });
});

describe('visualReviewRoundGroups (the task page: one group per round, latest first)', () => {
  it('a round-2 audit shows round 2, then round 1', () => {
    const groups = visualReviewRoundGroups(model(), 2);
    expect(groups.map(g => g.round)).toEqual([2, 1]);
    expect(groups[0].model.cells.every(c => c.current.round === 2)).toBe(true);
  });

  it('only screens still current in the mission can be decided: a re-shot one is history', () => {
    const [r2, r1] = visualReviewRoundGroups(model(), 2);
    expect(r2.deckModel?.cells.map(c => c.key)).toEqual(['/app/tasks/:id|mobile|']);
    expect(r1.model.cells.length).toBe(7);
    expect(r1.deckModel?.cells.length).toBe(6);
    expect(r1.deckModel?.cells.some(c => c.key === '/app/tasks/:id|mobile|')).toBe(false);
  });

  it('a round-1 audit never shows the later round\'s re-shoots', () => {
    const groups = visualReviewRoundGroups(model(), 1);
    expect(groups.map(g => g.round)).toEqual([1]);
  });

  it('no screens: no groups', () => {
    expect(visualReviewRoundGroups(buildVisualReviewFixtureModel('queued'), 1)).toEqual([]);
  });
});
