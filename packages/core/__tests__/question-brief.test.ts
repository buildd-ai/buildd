import { describe, expect, test } from 'bun:test';
import {
  BRIEF_CONTEXT_MAX,
  QUESTION_BRIEF_GUIDANCE,
  deriveQuestionBrief,
  missingBriefParts,
  questionNotificationText,
  questionPushbackText,
  sanitizeQuestionBrief,
  splitQuestionText,
} from '../question-brief';

describe('splitQuestionText', () => {
  test('leading statements become context, the question stays the prompt', () => {
    const r = splitQuestionText('Adding isWeekend() to the billing helpers. It decides weekend surcharges. Should it use local time or UTC?');
    expect(r.prompt).toBe('Should it use local time or UTC?');
    expect(r.context).toBe('Adding isWeekend() to the billing helpers. It decides weekend surcharges.');
  });

  test('a bare question has no context', () => {
    expect(splitQuestionText('Should isWeekend use local time or UTC?')).toEqual({ prompt: 'Should isWeekend use local time or UTC?' });
  });

  test('text that does not end in a question is left whole', () => {
    expect(splitQuestionText('Pick a database. Postgres or SQLite.')).toEqual({ prompt: 'Pick a database. Postgres or SQLite.' });
  });

  test('context is capped at two sentences', () => {
    const r = splitQuestionText('One. Two. Three. Which?');
    expect(r.context).toBe('One. Two.');
    expect(r.prompt).toBe('Which?');
  });

  test('a multi-sentence question stays whole', () => {
    const r = splitQuestionText('The export job is slow. Batch it? Or stream it?');
    expect(r.prompt).toBe('Batch it? Or stream it?');
    expect(r.context).toBe('The export job is slow.');
  });
});

describe('deriveQuestionBrief', () => {
  test('descriptions become consequences and "(Recommended)" marks the default', () => {
    const b = deriveQuestionBrief(
      {
        question: 'isWeekend() decides weekend surcharges. Should it use local time or UTC?',
        options: [
          { label: 'Local time (Recommended)', description: 'Customers are charged by their own calendar.' },
          { label: 'UTC', description: 'Late Friday customers in the Americas get weekend rates.' },
        ],
      },
      { taskTitle: 'Add weekend surcharge', branch: 'buildd/abc-weekend', file: 'src/billing/dates.ts' },
    );
    expect(b.prompt).toBe('Should it use local time or UTC?');
    expect(b.context).toBe('isWeekend() decides weekend surcharges.');
    expect(b.options[0]).toMatchObject({ label: 'Local time', recommended: true, consequence: 'Customers are charged by their own calendar.' });
    expect(b.options[1]).toMatchObject({ label: 'UTC', consequence: 'Late Friday customers in the Americas get weekend rates.' });
    expect(b.options[1].recommended).toBeUndefined();
    expect(b.recommended).toEqual({ label: 'Local time', reason: 'Customers are charged by their own calendar.' });
    expect(b.where).toEqual({ taskTitle: 'Add weekend surcharge', branch: 'buildd/abc-weekend', file: 'src/billing/dates.ts' });
  });

  test('never invents text the agent did not write', () => {
    const b = deriveQuestionBrief({ question: 'Local or UTC?', options: [{ label: 'Local' }, { label: 'UTC' }] });
    expect(b.context).toBeUndefined();
    expect(b.recommended).toBeUndefined();
    expect(b.where).toBeUndefined();
    expect(b.options).toEqual([{ label: 'Local' }, { label: 'UTC' }]);
  });
});

describe('sanitizeQuestionBrief', () => {
  test('keeps well-formed fields, caps them, drops junk', () => {
    const long = 'x'.repeat(1000);
    const out = sanitizeQuestionBrief({
      context: long,
      recommended: { label: 'UTC', reason: 42 },
      where: { taskTitle: 'T', branch: 7, file: '' },
      options: [{ label: 'UTC', consequence: '  one line  ' }, { label: 'Local', consequence: 5 }, 'bare'],
    });
    expect(out.context!.length).toBeLessThanOrEqual(BRIEF_CONTEXT_MAX);
    expect(out.recommended).toEqual({ label: 'UTC' });
    expect(out.where).toEqual({ taskTitle: 'T' });
    expect(out.options).toEqual([{ label: 'UTC', consequence: 'one line' }, { label: 'Local' }, 'bare']);
  });

  test('an old payload yields nothing', () => {
    expect(sanitizeQuestionBrief({ type: 'question', prompt: 'Which?' })).toEqual({});
    expect(sanitizeQuestionBrief(null)).toEqual({});
  });
});

describe('pushback text', () => {
  test('names exactly what is missing', () => {
    const bare = { prompt: 'Should isWeekend use local time or UTC?', options: ['local time', 'UTC'] };
    const missing = missingBriefParts(bare);
    expect(missing).toHaveLength(3);
    const text = questionPushbackText(bare);
    expect(text).toStartWith('Not sent: a reader with no context could not decide');
    expect(text).toContain('what is being decided');
    expect(text).toContain('what choosing it leads to');
    expect(text).toContain('recommended default');
    expect(text).toEndWith('Then ask again.');
  });

  test('a complete brief still gets a reason', () => {
    const full = {
      prompt: 'Which?',
      context: 'Task X.',
      options: [{ label: 'A', consequence: 'a', recommended: true }, { label: 'B', consequence: 'b' }],
    };
    expect(missingBriefParts(full)).toEqual([]);
    expect(questionPushbackText(full)).toContain('plain words');
  });
});

describe('questionNotificationText', () => {
  test('title, question, one line of context and the recommendation', () => {
    const n = questionNotificationText({
      prompt: 'Should it use local time or UTC?',
      context: 'isWeekend() decides weekend surcharges. Second sentence.',
      recommended: { label: 'Local time', reason: 'Customers are charged by their own calendar.' },
    });
    expect(n.title).toBe('Agent needs your input');
    expect(n.message.split('\n')).toEqual([
      'Should it use local time or UTC?',
      'isWeekend() decides weekend surcharges.',
      'Recommended: Local time. Customers are charged by their own calendar.',
    ]);
  });

  test('falls back to the task title, then to the bare prompt', () => {
    expect(questionNotificationText({ prompt: 'Which?', where: { taskTitle: 'Fix billing' } }).message).toBe('Which?\nTask: Fix billing');
    expect(questionNotificationText({ prompt: 'Which?' }).message).toBe('Which?');
  });

  test('sensitive workspaces get the generic line only', () => {
    expect(questionNotificationText({ prompt: 'secret', context: 'secret' }, { sensitive: true }).message).toBe('Agent waiting for input');
  });
});

test('guidance tells the agent the reader has no context', () => {
  expect(QUESTION_BRIEF_GUIDANCE).toContain('self-contained decision brief');
  expect(QUESTION_BRIEF_GUIDANCE).toContain('(Recommended)');
});
