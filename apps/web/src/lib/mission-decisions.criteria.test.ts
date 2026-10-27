import { describe, expect, it } from 'bun:test';
import { criteriaEscalationDecision, historyOnScreen } from './mission-decisions';
import type { DecisionView } from './needs-you-card';

const SPEC_TITLE = 'Windows runner through WSL2: one guided setup';
const base = {
  missionId: 'm1', workspaceId: 'w1', fileWorkHref: '/app/tasks/new',
  mission: { id: 'm1', title: SPEC_TITLE, href: '/app/missions/m1' }, askedAt: 5,
  asker: { id: 't9', title: '[final verification] Windows runner through WSL2', href: '/app/tasks/t9' },
};
const unmet = { count: 4, state: 'not checked', names: ['WSL2 install step', 'Runner starts on boot', 'Setup reports progress', 'Errors say what to change'] };

describe('criteriaEscalationDecision (Navigation R-16)', () => {
  const d = criteriaEscalationDecision({ ...base, unmet });

  it('the header is the asking task with the age it asked at', () => {
    expect(d.task).toEqual(base.asker);
    expect(d.askedAt).toBe(5);
  });
  it('the summary names the requirements in words and what waits, with no spec title or revision', () => {
    expect(d.summary).toBe('4 requirements not checked: WSL2 install step, Runner starts on boot, Setup reports progress and 1 more. The mission finishes once these pass or are waived.');
    expect(d.summary).not.toContain(SPEC_TITLE);
    expect(d.summary).not.toMatch(/revision|Spec "/);
  });
  it('asks a short question, then two options that each state their effect', () => {
    expect(d.question).toBe('Ship without these 4 checks?');
    expect(d.options.map(o => o.label)).toEqual(['File the work', 'Waive and complete']);
    expect(d.options.every(o => !!o.effect)).toBe(true);
    expect(d.answer).toEqual({ kind: 'criteria', missionId: 'm1', workspaceId: 'w1', fileWorkHref: '/app/tasks/new' });
    expect(d.shortcut).toBe(false);
  });
  it('one requirement asks in the singular; none known asks plainly', () => {
    expect(criteriaEscalationDecision({ ...base, unmet: { count: 1, state: 'not met', names: ['WSL2 install step'] } }).question).toBe('Ship without this check?');
    const plain = criteriaEscalationDecision({ ...base, unmet: null, asker: null });
    expect(plain.question).toBe('Ship without the open checks?');
    expect(plain.summary).toBe('The mission finishes once the open checks pass or are waived.');
    // No asking task: the header still names something.
    expect(plain.label).toBe('Requirements check');
  });
});

describe('criteriaEscalationFor (the page assembly)', () => {
  const { criteriaEscalationFor } = require('./mission-decisions') as typeof import('./mission-decisions');
  const page = { displayState: 'waiting_decision', surfaceAuditBlocked: false, criteriaUnmet: true, ...base, unmet };
  it('a waiting_decision mission with an unmet criterion gets the card with both options', () => {
    const v = criteriaEscalationFor(page);
    expect(v?.options.map(o => o.label)).toEqual(['File the work', 'Waive and complete']);
    expect(v?.answer.kind).toBe('criteria');
  });
  it('is absent when the wait is not a decision, the criteria pass, or the visual audit holds', () => {
    expect(criteriaEscalationFor({ ...page, displayState: 'active' })).toBeNull();
    expect(criteriaEscalationFor({ ...page, criteriaUnmet: false })).toBeNull();
    expect(criteriaEscalationFor({ ...page, surfaceAuditBlocked: true })).toBeNull();
  });
});

describe('historyOnScreen (f7f67f1a R-37: each fact once)', () => {
  const failed = { kind: 'failed' as const, text: 'Failed: Re-grade WSL2 guided setup', taskId: 't1', noteId: null };
  const decision = { kind: 'decision' as const, text: 'Decision open: Which distro?', taskId: null, noteId: 'n1' };
  const card = (key: string, answer: DecisionView['answer']) => ({ key, answer }) as DecisionView;

  it('a failure or reopened task is dropped while its row is on screen', () => {
    expect(historyOnScreen(failed, { buildRowsShown: true, decisions: [] })).toBeNull();
    expect(historyOnScreen({ ...failed, kind: 'reopened' }, { buildRowsShown: true, decisions: [] })).toBeNull();
    expect(historyOnScreen(failed, { buildRowsShown: false, decisions: [] })).toEqual(failed);
  });
  it('an open decision is dropped while its card is on screen', () => {
    expect(historyOnScreen(decision, { buildRowsShown: true, decisions: [card('note:n1', { kind: 'note', missionId: 'm1', noteId: 'n1' })] })).toBeNull();
    expect(historyOnScreen(decision, { buildRowsShown: true, decisions: [card('question:t2', { kind: 'worker', workerId: 'w', taskId: 't2', noteId: 'n1' })] })).toBeNull();
    expect(historyOnScreen(decision, { buildRowsShown: true, decisions: [] })).toEqual(decision);
  });
});
