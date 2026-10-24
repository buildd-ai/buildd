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

describe('criteriaEscalationFor (the page assembly)', () => {
  const { criteriaEscalationFor } = require('./mission-decisions') as typeof import('./mission-decisions');
  const base = {
    displayState: 'waiting_decision', surfaceAuditBlocked: false, criteriaUnmet: true,
    missionId: 'm1', reading: 'Check not verified.', criterion: 'Spec "X" revision 1',
    fileWorkHref: '/app/tasks/new?from=m1', mission: { id: 'm1', title: 'M', href: '/app/missions/m1' }, askedAt: null,
  };
  it('a waiting_decision mission with an unmet criterion gets the card with both options', () => {
    const v = criteriaEscalationFor(base);
    expect(v?.options.map(o => o.label)).toEqual(['File the work', 'Waive and complete']);
    expect(v?.answer.kind).toBe('criteria');
  });
  it('is absent when the wait is not a decision, the criteria pass, or the visual audit holds', () => {
    expect(criteriaEscalationFor({ ...base, displayState: 'active' })).toBeNull();
    expect(criteriaEscalationFor({ ...base, criteriaUnmet: false })).toBeNull();
    expect(criteriaEscalationFor({ ...base, surfaceAuditBlocked: true })).toBeNull();
  });
});
