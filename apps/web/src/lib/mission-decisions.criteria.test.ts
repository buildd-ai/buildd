import { describe, expect, it } from 'bun:test';
import { criteriaEscalationDecision } from './mission-decisions';

const base = {
  missionId: 'm1', fileWorkHref: '/app/tasks/new', mission: { id: 'm1', title: 'Cloud runner', href: '/app/missions/m1' }, askedAt: 5,
};

describe('criteriaEscalationDecision', () => {
  it('asks a real question naming the check, with two options that each state their effect', () => {
    const d = criteriaEscalationDecision({ ...base, reading: 'Check not verified.', criterion: 'Spec "Cloud runner: deploy" revision 1' });
    expect(d.question).toBe('Ship without the "Cloud runner: deploy" check?');
    expect(d.options.map(o => o.label)).toEqual(['File the work', 'Waive and complete']);
    expect(d.options.every(o => !!o.effect)).toBe(true);
    expect(d.answer.kind).toBe('criteria');
    expect(d.shortcut).toBe(false);
  });
  it('falls back to a plain question without a named check', () => {
    expect(criteriaEscalationDecision({ ...base, reading: null, criterion: null }).question).toBe('Ship without the unmet check?');
  });
});
