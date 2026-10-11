import { describe, test, expect } from 'bun:test';
import { normalizeOptions, unifyWorkerQuestion, unifyNoteQuestion, linkQuestionNote } from './question-hero';
import { isContextFree } from '@buildd/core/human-attention';

const note = {
  id: 'n1',
  workerId: 'w1',
  type: 'question',
  status: 'open',
  title: 'Round per line, or only the total?',
  body: 'Rounding each line can differ from rounding the total. Per line: the total equals exactly what the card is charged. Total only: matches the ledger, but the charge can be off by a cent. Which one?',
  defaultChoice: 'Per line — match Stripe',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('normalizeOptions', () => {
  test('accepts strings and objects, keeps description/recommended', () => {
    expect(normalizeOptions(['A', { label: 'B', description: 'why', recommended: true }])).toEqual([
      { label: 'A', recommended: false },
      { label: 'B', description: 'why', recommended: true },
    ]);
  });

  test('drops empty labels and tolerates garbage', () => {
    expect(normalizeOptions(['', { label: '  ' } as any, null as any, 'C'])).toEqual([{ label: 'C', recommended: false }]);
    expect(normalizeOptions(undefined)).toEqual([]);
  });

  test('maps a note defaultChoice onto the matching option as recommended', () => {
    const out = normalizeOptions(['Per line — match Stripe', 'Total only — match the ledger'], 'per line — match stripe');
    expect(out.map(o => o.recommended)).toEqual([true, false]);
  });
});

describe('unifyWorkerQuestion', () => {
  test('a linked note supplies headline, body, recommendation and per-option consequences', () => {
    const q = unifyWorkerQuestion(
      { type: 'question', prompt: 'Round converted amounts per line or only on the total?', options: ['Per line — match Stripe', 'Total only — match the ledger'] },
      note,
    );
    expect(q.headline).toBe('Round per line, or only the total?');
    // The per-option sentences moved onto the options; the body keeps the rest.
    expect(q.body).toBe('Rounding each line can differ from rounding the total. Which one?');
    expect(q.noteId).toBe('n1');
    expect(q.options).toEqual([
      { label: 'Per line — match Stripe', recommended: true, description: 'The total equals exactly what the card is charged.' },
      { label: 'Total only — match the ledger', recommended: false, description: 'Matches the ledger, but the charge can be off by a cent.' },
    ]);
  });

  test('without a note, the prompt is the headline and options pass through', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'Which?', options: [{ label: 'X', description: 'd' }] }, null);
    expect(q).toMatchObject({ headline: 'Which?', body: null, noteId: null, options: [{ label: 'X', description: 'd', recommended: false }] });
  });

  test.each([
    ['colon', 'Per line: match Stripe', 'Total only: match the ledger'],
    ['spaced hyphen', 'Per line - match Stripe', 'Total only - match the ledger'],
    ['en dash', 'Per line – match Stripe', 'Total only – match the ledger'],
  ])('a label whose lead is set off by a %s still finds its consequence', (_sep, a, b) => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'p', options: [a, b] }, note);
    expect(q.options.map(o => o.description)).toEqual([
      'The total equals exactly what the card is charged.',
      'Matches the ledger, but the charge can be off by a cent.',
    ]);
    expect(q.body).toBe('Rounding each line can differ from rounding the total. Which one?');
  });

  test('a structured description still takes its paragraph out of the body', () => {
    const q = unifyWorkerQuestion(
      { type: 'question', prompt: 'p', options: [{ label: 'Per line: match Stripe', description: 'mine' }, { label: 'Total only', description: 'theirs' }] },
      note,
    );
    expect(q.options.map(o => o.description)).toEqual(['mine', 'theirs']);
    expect(q.body).toBe('Rounding each line can differ from rounding the total. Which one?');
  });

  test('an explicit option description is never overwritten from the note body', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'p', options: [{ label: 'Per line — match Stripe', description: 'mine' }] }, note);
    expect(q.options[0].description).toBe('mine');
  });
});

describe('unifyNoteQuestion', () => {
  test('a note question with a default choice offers it as the recommended option', () => {
    const q = unifyNoteQuestion(note);
    expect(q.headline).toBe(note.title);
    expect(q.options).toEqual([{ label: 'Per line — match Stripe', recommended: true, description: 'The total equals exactly what the card is charged.' }]);
  });

  test('no default choice means free text only', () => {
    expect(unifyNoteQuestion({ ...note, defaultChoice: null }).options).toEqual([]);
  });
});

describe('linkQuestionNote', () => {
  test('prefers the open question posted by the waiting worker', () => {
    const other = { ...note, id: 'n2', workerId: 'w9' };
    expect(linkQuestionNote([other, note], 'w1')?.id).toBe('n1');
  });

  test('falls back to the only open question when none names the worker', () => {
    expect(linkQuestionNote([{ ...note, workerId: null }], 'w1')?.id).toBe('n1');
  });

  test('never links answered notes or ambiguous sets', () => {
    expect(linkQuestionNote([{ ...note, status: 'answered' }], 'w1')).toBeNull();
    expect(linkQuestionNote([{ ...note, workerId: null }, { ...note, id: 'n3', workerId: null }], 'w1')).toBeNull();
  });
});

describe('question brief', () => {
  const briefed = {
    type: 'question',
    prompt: 'Should it use local time or UTC?',
    context: 'isWeekend() decides weekend surcharges.',
    options: [
      { label: 'Local time', description: 'agent prose', consequence: 'Customers are charged by their own calendar.' },
      { label: 'UTC' },
    ],
    recommended: { label: 'local time', reason: 'Matches what customers see.' },
    where: { taskTitle: 'Weekend surcharge', branch: 'buildd/abc-weekend' },
  };

  test('carries context and where; consequence beats description; the brief marks the default', () => {
    const q = unifyWorkerQuestion(briefed, null);
    expect(q.context).toBe('isWeekend() decides weekend surcharges.');
    expect(q.where).toEqual({ taskTitle: 'Weekend surcharge', branch: 'buildd/abc-weekend' });
    expect(q.options).toEqual([
      { label: 'Local time', description: 'Customers are charged by their own calendar.', recommended: true },
      { label: 'UTC', recommended: false },
    ]);
  });

  test('the recommendation reason fills an option that has no line of its own', () => {
    const q = unifyWorkerQuestion({ ...briefed, options: [{ label: 'Local time' }, { label: 'UTC' }] }, null);
    expect(q.options[0]).toEqual({ label: 'Local time', recommended: true, description: 'Matches what customers see.' });
  });

  test('an old question without a brief is unchanged', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'Which?', options: ['A', 'B'] }, null);
    expect(q).toEqual({ headline: 'Which?', body: null, noteId: null, options: [{ label: 'A', recommended: false }, { label: 'B', recommended: false }] });
  });
});

describe('unifyWorkerQuestion: never a context-free card', () => {
  const ERROR = 'needs_input: Visual QA cannot boot the app: the mission migration is below the migration high-water mark. I re-ran the capture twice. How should I proceed?';

  test('a question parked without its brief gets the context back from the worker error', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'How should I proceed?', options: [] }, null, { workerError: ERROR });
    expect(q.headline).toBe('How should I proceed?');
    expect(q.context).toContain('high-water mark');
    expect(isContextFree({ prompt: q.headline, context: q.context, options: q.options })).toBe(false);
  });

  test('the brief context wins over the error', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'How should I proceed?', context: 'Own words.' }, null, { workerError: ERROR });
    expect(q.context).toBe('Own words.');
  });

  test('with nothing else, the task title says where it was asked', () => {
    const q = unifyWorkerQuestion({ type: 'question', prompt: 'How should I proceed?' }, null, { taskTitle: 'Surface audit' });
    expect(q.context).toBe('Asked while working on "Surface audit".');
  });
});
