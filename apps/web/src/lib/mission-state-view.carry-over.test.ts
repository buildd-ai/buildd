// Spec f7f67f1a r8 R-32 / R-33, AC-15 / AC-16: a mission whose PR merged with
// only the visual review left reads by that check, never Stalled; a held open
// task names the claim gate's hold instead of "nothing is running".
import { describe, expect, it } from 'bun:test';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';
import { getMissionStateChip } from './mission-helpers';

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

  it('without a merged mission PR an open audit is next in line, not a visual check', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [audit] });
    expect(v.chip.label).toBe('NEXT IN LINE');
  });

  it('a build task open beside the audit is not read as the visual review', () => {
    const v = deriveMissionStateView({ ...base, missionPrMerged: true, openTasks: [audit, { id: 'b1', status: 'pending', title: 'Build it' }] });
    expect(v.chip.label).not.toContain('VISUAL');
  });
});

describe('R-33: a held open task names its hold', () => {
  it('budget paused is a wait with a cause, not a stall', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [{ id: 'b1', status: 'pending', title: 'Build it', holdReason: 'budget_paused' }] });
    expect(v.displayState).toBe('active');
    expect(v.chip.label).toBe('WAITING');
    // Navigation R-14 words the budget hold; the bare reason carries no reset time.
    expect(v.situation?.headline).toBe('The open task is queued · team daily budget reached.');
  });

  it('an unknown reason reads waiting, with no invented cause (AC-9)', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [{ id: 'b1', status: 'pending', title: 'Build it', holdReason: 'something_new' }] });
    expect(v.chip.label).toBe('WAITING');
    expect(v.situation?.headline).toBe('The open task is waiting.');
  });

  it('rows held for different reasons do not invent one cause', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [
      { id: 'b1', status: 'pending', holdReason: 'budget_paused' },
      { id: 'b2', status: 'pending', holdReason: 'mission_concurrent' },
    ] });
    expect(v.situation?.headline).toBe('2 open tasks are waiting.');
  });
});

describe('visual review round 1: the header reads the visual review state', () => {
  const merged = { ...base, missionPrMerged: true };
  it('a waived review is not queued and the mission is not stalled', () => {
    const v = deriveMissionStateView({ ...merged, visualReview: { status: 'waived' }, openTasks: [{ ...audit, holdReason: 'budget_paused' }] });
    expect(v.chip.label).not.toBe('VISUAL REVIEW QUEUED');
    expect(v.displayState).not.toBe('stalled');
    expect(v.situation?.headline.toLowerCase() ?? '').not.toContain('visual review queued');
  });
  it('a blocked review says it cannot run, with its cause, and no other cause', () => {
    const v = deriveMissionStateView({ ...merged, visualReview: { status: 'blocked', blockedDetail: 'it needs a runner with a browser' }, openTasks: [{ ...audit, holdReason: 'budget_paused' }] });
    expect(v.chip.label).toBe('VISUAL REVIEW UNABLE TO RUN');
    expect(v.situation?.headline).toContain('it needs a runner with a browser');
    expect(v.situation?.headline).not.toContain('budget');
  });
  it('a running review reads running', () => {
    const v = deriveMissionStateView({ ...merged, visualReview: { status: 'running' }, openTasks: [audit] });
    expect(v.chip.label).toBe('VISUAL REVIEW RUNNING');
  });
  it('a missing browser runner is the one cause, ahead of a claim-loop hold', () => {
    const v = deriveMissionStateView({ ...merged, openTasks: [{ ...audit, holdReason: 'budget_paused', missingBrowser: true }] });
    expect(v.situation?.headline).toContain('it needs a runner with a browser');
    expect(v.situation?.headline).not.toContain('budget');
    const plain = deriveMissionStateView({ ...base, openTasks: [{ id: 'b1', status: 'pending', title: 'Audit', holdReason: 'budget_paused', missingBrowser: true }] });
    expect(plain.situation?.headline).not.toContain('budget');
  });
});

describe('round 3: queued work nothing holds is next in line (spec 8e137fdb I-4, I-5)', () => {
  it('six queued tasks on runners read next in line in chip and headline, not Stalled', () => {
    const openTasks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, status: 'pending', title: `Task ${i}` }));
    const v = deriveMissionStateView({ ...base, openTasks });
    expect(v.chip.label).toBe('NEXT IN LINE');
    expect(v.displayState).not.toBe('stalled');
    expect(v.situation?.headline).toBe('6 open tasks are next in line for a runner.');
  });
  it('a started task with nothing running it is still the stall', () => {
    const v = deriveMissionStateView({ ...base, openTasks: [{ id: 't1', status: 'in_progress' }] });
    expect(v.displayState).toBe('stalled');
  });
});

describe('round 3: the quiet notice says what is left (spec 8e137fdb AC-7)', () => {
  const quiet: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL', progress: 100, hasPendingDeliverableWork: false };
  it('all clear reads ready to complete, not machine output', () => {
    const v = deriveMissionStateView(quiet);
    expect(v.situation?.headline).toBe('Ready to complete.');
  });
  it('an unchecked outcome spec is named', () => {
    const v = deriveMissionStateView({ ...quiet, openChecks: [{ label: 'Spec revision 3', state: 'not checked' }] });
    expect(v.situation?.headline).toBe('Waiting on Spec revision 3: not checked.');
    expect(v.situation?.openChecks).toEqual(['Spec revision 3']);
  });
});

describe('round 4: one all-clear phrase (spec 8e137fdb I-1)', () => {
  const quiet: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL', progress: 100, hasPendingDeliverableWork: false };
  it('chip and notice both say ready to complete', () => {
    const v = deriveMissionStateView(quiet);
    expect(v.chip.label).toBe('READY TO COMPLETE');
    expect(v.situation?.headline).toBe('Ready to complete.');
  });
  it('an open check is not ready to complete', () => {
    const v = deriveMissionStateView({ ...quiet, openChecks: [{ label: 'Spec revision 3', state: 'not checked' }] });
    expect(v.chip.label).toBe('CHECK PENDING');
    // A pending check is not a success (c9353c11): waiting tone, never the green one.
    expect(v.chip.cls).toBe(getMissionStateChip('awaiting_verification').cls);
    expect(v.chip.cls).not.toBe(getMissionStateChip('review').cls);
  });
  it('a PR still awaiting merge keeps Ready for review', () => {
    const v = deriveMissionStateView({ ...quiet, missionPr: { state: 'open', prNumber: 7, prUrl: 'u' }, completion: { ok: false, code: 'mission_pr_unmerged', reason: '' } as never });
    expect(v.chip.label).not.toBe('READY TO COMPLETE');
  });
});

describe('c9353c11: an open audit is never dropped as settled when the review could not be read', () => {
  it('optional (impact unknown) keeps the queued audit as what the mission waits on', () => {
    const v = deriveMissionStateView({ ...base, health: 'NOMINAL', progress: 100, missionPrMerged: true, openTasks: [audit], visualReview: { status: 'optional' }, completion: { ok: false, code: 'pending_deliverables', reason: '', pendingDeliverables: 1 } as never });
    expect(v.chip.label).not.toBe('READY TO COMPLETE');
    expect(v.situation?.headline ?? '').not.toMatch(/^Ready to complete|Nothing is waiting/);
  });
  it('waived still drops it', () => {
    const v = deriveMissionStateView({ ...base, health: 'NOMINAL', progress: 100, missionPrMerged: true, openTasks: [audit], visualReview: { status: 'waived' } });
    expect(v.chip.label).toBe('READY TO COMPLETE');
  });
});
