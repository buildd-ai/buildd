import { describe, expect, it } from 'bun:test';
import { HUMAN_CORRECTION_LABEL, labelHumanCorrection, type HumanCorrectionDeps } from '../decision-outcome-graders';

const AT = new Date('2026-10-05T12:00:00Z');

function deps(found: { id: string; appliedAnswer: string | null } | null) {
  const finds: any[] = [];
  const overrides: any[] = [];
  const labels: any[] = [];
  const d: HumanCorrectionDeps = {
    findApplied: async q => { finds.push(q); return found; },
    recordOverride: async (id, override, by) => { overrides.push({ id, override, by }); },
    label: (async (l: any) => { labels.push(l); return { ok: true, results: [{ decisionRecordId: l.decisionRecordId, status: 'recorded' }] }; }) as any,
  };
  return { d, finds, overrides, labels };
}

describe('labelHumanCorrection', () => {
  it('a person changing what a decision applied labels that decision human/overridden and sets its override', async () => {
    const t = deps({ id: 'dec-1', appliedAnswer: 'builder' });
    const res = await labelHumanCorrection(
      { teamId: 'team-1', capability: 'task_role_shadow', taskId: 'task-1', from: 'builder', to: 'researcher', by: 'user-1', at: AT },
      t.d,
    );
    expect(res).toBe('labelled');
    expect(t.finds[0]).toEqual({ teamId: 'team-1', capability: 'task_role_shadow', taskId: 'task-1', decisionRecordId: undefined });
    expect(t.overrides).toEqual([{ id: 'dec-1', override: { answer: 'researcher', from: 'builder', implicit: true }, by: 'user-1' }]);
    expect(t.labels).toEqual([{
      teamId: 'team-1', decisionRecordId: 'dec-1', source: 'human', label: HUMAN_CORRECTION_LABEL,
      metadata: { answer: 'researcher', from: 'builder', implicit: true }, observedAt: AT,
    }]);
  });

  it('a change the decision did not make (no applied row, or the row applied something else) writes nothing', async () => {
    for (const found of [null, { id: 'dec-1', appliedAnswer: 'designer' }]) {
      const t = deps(found);
      expect(await labelHumanCorrection({ teamId: 'team-1', capability: 'task_role_shadow', taskId: 'task-1', from: 'builder', to: 'researcher', by: 'u' }, t.d)).toBe('no_decision');
      expect(t.labels).toEqual([]);
      expect(t.overrides).toEqual([]);
    }
  });

  it('no change, or nothing to key on, is not a correction', async () => {
    const t = deps({ id: 'dec-1', appliedAnswer: 'builder' });
    expect(await labelHumanCorrection({ teamId: 'team-1', capability: 'c', taskId: 'task-1', from: 'builder', to: 'builder', by: 'u' }, t.d)).toBe('not_a_correction');
    expect(await labelHumanCorrection({ teamId: 'team-1', capability: 'c', from: 'builder', to: 'x', by: 'u' }, t.d)).toBe('not_a_correction');
    expect(t.finds).toEqual([]);
  });

  it('keys on a known decision row when the caller has it', async () => {
    const t = deps({ id: 'dec-9', appliedAnswer: 'wait-for-local' });
    expect(await labelHumanCorrection({ teamId: 'team-1', capability: 'mission_strand_choice', decisionRecordId: 'dec-9', from: 'wait-for-local', to: 'continue-on-runner', by: null }, t.d)).toBe('labelled');
    expect(t.finds[0]).toMatchObject({ decisionRecordId: 'dec-9' });
    // No actor id: the label is still written; the override needs one.
    expect(t.overrides).toEqual([]);
    expect(t.labels).toHaveLength(1);
  });

  it('never throws: a failing store reads as failed', async () => {
    const t = deps(null);
    t.d.findApplied = async () => { throw new Error('db down'); };
    expect(await labelHumanCorrection({ teamId: 'team-1', capability: 'c', taskId: 't', from: 'a', to: 'b', by: 'u' }, t.d)).toBe('failed');
  });
});
