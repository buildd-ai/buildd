import { describe, test, expect } from 'bun:test';
import { normalizeOptions, unifyWorkerQuestion, unifyNoteQuestion, linkQuestionNote } from './question-hero';

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
