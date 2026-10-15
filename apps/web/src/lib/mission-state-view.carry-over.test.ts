// Spec f7f67f1a r8 R-32 / R-33, AC-15 / AC-16: a mission whose PR merged with
// only the visual review left reads by that check, never Stalled; a held open
// task names the claim gate's hold instead of "nothing is running".
import { describe, expect, it } from 'bun:test';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'STALLED' };
const audit = { id: 'a1', status: 'pending', title: '[surface audit] Visual review', surfaceAudit: true };

describe('R-32: merged mission PR, visual review open', () => {
  it('reads Visual review queued, not Stalled', () => {
    const v = deriveMissionStateView({ ...base, missionPrMerged: true, openTasks: [audit] });
    expect(v.displayState).toBe('awaiting_verification');
    expect(v.chip.label).toBe('VISUAL REVIEW QUEUED');
    expect(v.situation?.headline.toLowerCase()).toContain('visual review queued');
    expect(v.situation?.headline.toLowerCase()).not.toContain('nothing is running');
  });

  it('carries the hold when the claim loop named one (AC-16)', () => {
    const v = deriveMissionStateView({ ...base, missionPrMerged: true, openTasks: [{ ...audit, holdReason: 'budget_paused' }] });
    expect(v.situation?.headline).toContain('runners paused new work until the model budget resets');
  });

  it('without a merged mission PR an open audit is still the plain stall', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [audit] });
    expect(v.displayState).toBe('stalled');
  });

  it('a build task open beside the audit keeps the stall', () => {
    const v = deriveMissionStateView({ ...base, missionPrMerged: true, openTasks: [audit, { id: 'b1', status: 'pending', title: 'Build it' }] });
    expect(v.displayState).toBe('stalled');
  });
});

describe('R-33: a held open task names its hold', () => {
  it('budget paused is a wait with a cause, not a stall', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [{ id: 'b1', status: 'pending', title: 'Build it', holdReason: 'budget_paused' }] });
    expect(v.displayState).toBe('active');
    expect(v.chip.label).toBe('WAITING');
    expect(v.situation?.headline).toContain('queued: runners paused new work until the model budget resets');
  });

  it('an unknown reason falls back to the stall', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [{ id: 'b1', status: 'pending', title: 'Build it', holdReason: 'something_new' }] });
    expect(v.displayState).toBe('stalled');
  });

  it('rows held for different reasons do not invent one cause', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [
      { id: 'b1', status: 'pending', holdReason: 'budget_paused' },
      { id: 'b2', status: 'pending', holdReason: 'workspace_cap' },
    ] });
    expect(v.displayState).toBe('stalled');
  });
});
