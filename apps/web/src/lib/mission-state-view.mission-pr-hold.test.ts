/**
 * Spec 072de598 I-12 / AC-10: the open mission PR reads "ready to merge" only
 * when nothing holds it. Its visual review owed or open, or its CI red, is the
 * reading instead, on the completion-gate path (explain, the mission page) and
 * the rows path (cards, Home) alike.
 */
import { describe, it, expect } from 'bun:test';
import { deriveMissionStateView, isGated, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };
const MPR = { state: 'open' as const, prNumber: 77, prUrl: 'https://example.invalid/pr/77' };
const viaGate: Partial<MissionStateInput> = {
  completion: { ok: false, code: 'awaiting_mission_pr', reason: 'The mission PR has not merged', awaitingMerge: 1, awaitingMergeDetails: [] },
  missionPr: MPR,
};
const viaRows: Partial<MissionStateInput> = { missionPr: MPR };
const visualSystem = { status: 'needed', blockedDetail: null, blocksMerge: true, label: 'Waiting for a new screenshot of /app/x · dialog · phone', needsOwner: false };
const visualOwner = { status: 'findings', blockedDetail: null, blocksMerge: true, label: '2 fixes merged with no new screenshot', needsOwner: true };

for (const [path, extra] of [['completion gate', viaGate], ['rows', viaRows]] as const) {
  describe(`the open mission PR (${path})`, () => {
    it('with nothing holding it, reads ready to merge', () => {
      const view = deriveMissionStateView({ ...base, ...extra });
      expect(view.situation.headline).toContain('ready to merge');
    });

    it('a visual review the system is finishing: waiting, names it, never ready to merge', () => {
      const view = deriveMissionStateView({ ...base, ...extra, visualReview: visualSystem });
      expect(isGated(view) && view.waitingOn.kind).toBe('landing_blocked');
      expect(view.situation.headline).not.toContain('ready to merge');
      expect(view.situation.headline).toContain('waits on the visual review: waiting for a new screenshot of /app/x · dialog · phone');
      expect(view.displayState).not.toBe('blocked');
    });

    it('a queued recapture: waiting, a new screenshot is coming, no owner and no decide or skip', () => {
      const view = deriveMissionStateView({ ...base, ...extra, visualReview: { ...visualSystem, recaptureComing: true } });
      if (!isGated(view) || view.waitingOn.kind !== 'landing_blocked') throw new Error('expected landing_blocked');
      expect(view.waitingOn.owner).not.toBe('person');
      expect(view.waitingOn.nextAction).toContain('new screenshot is on its way');
      expect(view.waitingOn.nextAction).not.toMatch(/decide|skip/i);
    });

    it('a visual review a person must decide: the person is asked, never ready to merge', () => {
      const view = deriveMissionStateView({ ...base, ...extra, visualReview: visualOwner });
      if (!isGated(view) || view.waitingOn.kind !== 'landing_blocked') throw new Error('expected landing_blocked');
      expect(view.waitingOn.owner).toBe('person');
      expect(view.situation.headline).not.toContain('ready to merge');
    });

    it('red CI on the mission PR: blocked on CI, never ready to merge', () => {
      const view = deriveMissionStateView({ ...base, ...extra, missionPr: { ...MPR, ciRed: true } });
      expect(isGated(view) && view.waitingOn.kind).toBe('ci_red');
      expect(view.situation.headline).toContain('CI red');
      expect(view.situation.headline).not.toContain('ready to merge');
      expect(view.situation.headline).not.toContain('0 fix attempts');
    });

    it('a review that does not block the merge (waived, passed) leaves it ready to merge', () => {
      const view = deriveMissionStateView({ ...base, ...extra, visualReview: { status: 'waived', blockedDetail: null } });
      expect(view.situation.headline).toContain('ready to merge');
    });
  });
}
