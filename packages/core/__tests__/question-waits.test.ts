/**
 * Living Spec 1b257609 revision 2: outcome kinds on options (R-4, R-11,
 * AC-6, AC-11), the runner's fixed form, and the card's words (R-6 to R-9).
 */
import { describe, expect, test } from 'bun:test';
import {
  OUTCOME_KIND_GUIDANCE,
  OUTCOME_TAG_GUIDANCE,
  formatSpan,
  effectFor,
  optionOutcomes,
  outcomeEffect,
  parseOutcomeKind,
  partsText,
  readOutcomeTag,
  waitsFooter,
  waitsNotificationLine,
  waitsSummary,
  type QuestionWaits,
  type WaitingTask,
} from '../question-waits';
import { QUESTION_BRIEF_GUIDANCE, deriveQuestionBrief, normalizeDecisionOptions, questionNotificationText, sanitizeQuestionBrief } from '../question-brief';

const B: WaitingTask = { id: 'b', title: 'Repair', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false };

const waits = (over: Partial<QuestionWaits> = {}): QuestionWaits => ({
  taskId: 't', mission: null, waiting: [B], hiddenCount: 0, beyondCount: 0, lanes: [], criteria: null,
  askedAt: null, expiresAt: null, onExpiry: { action: 'restart', option: null }, options: [], ...over,
});

describe('outcome kinds', () => {
  test('parse only the four kinds', () => {
    expect(parseOutcomeKind('Finishes')).toBe('finishes');
    expect(parseOutcomeKind('done')).toBeUndefined();
    expect(parseOutcomeKind(3)).toBeUndefined();
  });

  test('the runner reads a kind only from the fixed bracket form', () => {
    expect(readOutcomeTag('[finishes] Ships it as is.')).toEqual({ kind: 'finishes', rest: 'Ships it as is.' });
    expect(readOutcomeTag(' [ Stops ]  The task fails.')).toEqual({ kind: 'stops', rest: 'The task fails.' });
    expect(readOutcomeTag('Finishes: ships it.').kind).toBeUndefined();
    expect(readOutcomeTag('This finishes the task.').kind).toBeUndefined();
    expect(readOutcomeTag('Ships it [finishes]').kind).toBeUndefined();
  });

  test('deriveQuestionBrief takes the kind off the description', () => {
    const q = deriveQuestionBrief({ question: 'Ship?', options: [
      { label: 'Ship (Recommended)', description: '[finishes] Ships the fix as it is.' },
      { label: 'Keep going', description: 'More tests first.' },
    ] });
    expect(q.options[0]).toMatchObject({ label: 'Ship', outcome: 'finishes', consequence: 'Ships the fix as it is.', recommended: true });
    expect(q.options[0].description).toBe('Ships the fix as it is.');
    expect(q.recommended).toEqual({ label: 'Ship', reason: 'Ships the fix as it is.' });
    expect(q.options[1].outcome).toBeUndefined();
  });

  test('the guidance defines the form, and the runner guidance asks for it', () => {
    expect(OUTCOME_TAG_GUIDANCE).toContain('"[finishes] ');
    for (const k of ['continues', 'finishes', 'stops', 'changes']) expect(OUTCOME_KIND_GUIDANCE).toContain(k);
    expect(QUESTION_BRIEF_GUIDANCE).toContain(OUTCOME_KIND_GUIDANCE);
    expect(QUESTION_BRIEF_GUIDANCE).toContain(OUTCOME_TAG_GUIDANCE);
  });
});

describe('AC-11: ask_human options as strings or objects', () => {
  test('objects with a kind keep it', () => {
    const r = normalizeDecisionOptions([{ label: 'Ship', consequence: 'Ships it.', outcome: 'finishes', recommended: true }, { label: 'Hold', outcome: 'continues' }]);
    expect('options' in r && r.options).toEqual([
      { label: 'Ship', consequence: 'Ships it.', effect: 'Ships it', recommended: true, outcome: 'finishes' },
      { label: 'Hold', outcome: 'continues' },
    ]);
  });

  test('plain strings work as before', () => {
    const r = normalizeDecisionOptions(['Yes', 'No']);
    expect('options' in r && r.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  test('an unknown kind is refused in words', () => {
    const r = normalizeDecisionOptions([{ label: 'Ship', outcome: 'done' }]);
    expect('error' in r && r.error).toContain('continues, finishes, stops or changes');
  });

  test('the stored brief keeps a valid kind and drops anything else', () => {
    const s = sanitizeQuestionBrief({ options: [{ label: 'A', outcome: 'stops' }, { label: 'B', outcome: 'explode' }, 'C'] });
    expect(s.options).toEqual([{ label: 'A', outcome: 'stops' }, { label: 'B' }, 'C']);
  });
});

describe('AC-6: effects', () => {
  test('each kind names the kind, then what it does to the waiting work', () => {
    expect(outcomeEffect('finishes', waits())).toBe('Finishes the task: Repair starts');
    expect(outcomeEffect('continues', waits())).toBe('Keeps working: Repair keeps waiting');
    expect(outcomeEffect('changes', waits())).toBe('Changes what it delivers: Repair starts on the changed result');
    expect(outcomeEffect('stops', waits())).toBe('Stops the task: Repair fails too');
  });

  test('a lane the task holds is freed by finishing or stopping, kept by continuing', () => {
    const lanes = [{ lane: 'schema', queued: [{ id: 'q', title: 'Add index', position: 2 }], hiddenCount: 0 }];
    expect(outcomeEffect('finishes', waits({ waiting: [], lanes }))).toBe('Finishes the task: frees the schema lane');
    expect(outcomeEffect('continues', waits({ lanes }))).toBe('Keeps working: Repair keeps waiting; keeps the schema lane');
  });

  test('hidden dependents are counted, never named', () => {
    expect(outcomeEffect('stops', waits({ waiting: [], hiddenCount: 2 }))).toBe("Stops the task: 2 tasks you can't see fail too");
    expect(outcomeEffect('finishes', waits({ hiddenCount: 1 }))).toBe("Finishes the task: Repair and 1 task you can't see start");
  });

  test('with nothing waiting it says so', () => {
    expect(outcomeEffect('finishes', waits({ waiting: [] }))).toBe('Finishes the task: nothing else waits on it');
  });

  test('R-8: the recommended option comes first; options without a kind carry no effect', () => {
    const o = optionOutcomes(['Hold', { label: 'Ship', outcome: 'finishes' }], waits(), 'ship');
    expect(o.map(x => [x.label, x.recommended, x.effect])).toEqual([
      ['Ship', true, 'Finishes the task: Repair starts'],
      ['Hold', false, null],
    ]);
    expect(effectFor(waits({ options: o }), 'Ship (Recommended)')).toBe('Finishes the task: Repair starts');
    expect(effectFor(waits({ options: o }), 'Hold')).toBeNull();
  });
});

describe('the card lines', () => {
  test('spans read in two units', () => {
    expect(formatSpan(30 * 60_000)).toBe('30 minutes');
    expect(formatSpan(210 * 60_000)).toBe('3 hours 30 minutes');
    expect(formatSpan(60 * 60_000)).toBe('1 hour');
    expect(formatSpan(50 * 3600_000)).toBe('2 days 2 hours');
  });

  test('every task and spec in the summary is a link; criterion ids stay in the data', () => {
    const parts = waitsSummary(waits({ mission: { id: 'm', title: 'M' }, criteria: { specId: 's', specTitle: 'S', affected: ['R-1'], total: 3 } }));
    expect(parts.filter(p => p.href).map(p => p.href)).toEqual(['/app/tasks/b', '/app/specs/s']);
    expect(partsText(parts)).toBe('Blocks Repair. Affects the evidence for 1 of 3 criteria in S.');
  });

  test('the footer: expiry and default, or nothing without an open question', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(waitsFooter(waits({ expiresAt: '2026-10-24T13:00:00Z', onExpiry: { action: 'ends', option: null } }), now)).toBe('Expires in 1h. Task ends.');
    expect(waitsFooter(waits({ expiresAt: '2026-10-24T11:00:00Z', onExpiry: { action: 'restart', option: null } }), now)).toBe('Expired. Task restarts.');
    expect(waitsFooter(waits(), now)).toBeNull();
  });

  test('the push line is the summary', () => {
    expect(waitsNotificationLine(waits())).toBe('Blocks Repair.');
    expect(waitsNotificationLine(waits({ waiting: [] }))).toBe('Nothing else waits on this answer.');
  });

  test('the notification carries the line after the question', () => {
    const n = questionNotificationText({ prompt: 'Ship it?' }, { waitsLine: 'Blocks Repair.' });
    expect(n.message).toBe('Ship it?\nBlocks Repair.');
    expect(questionNotificationText({ prompt: 'Ship it?' }, { sensitive: true, waitsLine: 'x' }).message).toBe('Agent waiting for input');
  });
});
