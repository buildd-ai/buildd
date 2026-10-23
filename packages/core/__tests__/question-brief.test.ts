import { describe, expect, test } from 'bun:test';
import {
  BRIEF_CONTEXT_MAX,
  DECISION_EFFECT_MAX,
  DECISION_OPTIONS_DEFAULT,
  DECISION_OPTIONS_GUIDANCE,
  DECISION_OPTIONS_MAX,
  DECISION_TITLE_GUIDANCE,
  QUESTION_BRIEF_GUIDANCE,
  deriveQuestionBrief,
  missingBriefParts,
  normalizeDecisionOptions,
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
    expect(n.title).toBe('Agent needs input');
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

describe('decision options (Navigation R-16, AC-16)', () => {
  test('four options are refused with a message to cut to two', () => {
    const r = normalizeDecisionOptions(['A', 'B', 'C', 'D']);
    expect('error' in r && r.error).toContain('Cut to two');
    expect('error' in r && r.error).toContain('free text');
  });

  test('three options are allowed; two is the default the guidance asks for', () => {
    expect(normalizeDecisionOptions(['A', 'B', 'C'])).toEqual({ options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
    expect(DECISION_OPTIONS_DEFAULT).toBe(2);
    expect(DECISION_OPTIONS_MAX).toBe(3);
  });

  test('"Not now" and "Skip" are never options', () => {
    for (const label of ['Not now', 'Skip', 'skip for now', 'Decide later']) {
      const r = normalizeDecisionOptions([{ label: 'Use a team secret', consequence: 'x' }, label]);
      expect('error' in r && r.error).toContain('Not now');
    }
    // A real choice that merely starts with the word stays.
    expect('options' in normalizeDecisionOptions(['Skip the flaky test', 'Fix the flaky test'])).toBe(true);
  });

  test('structured options keep the consequence and store a short effect for the button', () => {
    const r = normalizeDecisionOptions([
      { label: 'Team secret (Recommended)', consequence: 'Stores the token once for every workspace. The deploy task unblocks right away; nothing else waits.' },
      { label: 'Per workspace', consequence: 'Each workspace gets its own token.', effect: 'One token per workspace' },
    ]);
    if (!('options' in r)) throw new Error(r.error);
    const [a, b] = r.options;
    expect(a).toMatchObject({ label: 'Team secret', recommended: true });
    expect(a.consequence).toContain('deploy task unblocks');
    expect(a.effect!.length).toBeLessThanOrEqual(DECISION_EFFECT_MAX);
    expect(a.effect!.startsWith('Stores the token once')).toBe(true);
    expect(b).toEqual({ label: 'Per workspace', consequence: 'Each workspace gets its own token.', effect: 'One token per workspace' });
  });

  test('description is read as the consequence; only the first recommendation counts', () => {
    const r = normalizeDecisionOptions([
      { label: 'A', description: 'Ships A.', recommended: true },
      { label: 'B', description: 'Ships B.', recommended: true },
    ]);
    if (!('options' in r)) throw new Error(r.error);
    expect(r.options[0]).toMatchObject({ consequence: 'Ships A.', effect: 'Ships A', recommended: true });
    expect(r.options[1].recommended).toBeUndefined();
  });

  test('empty and repeated labels are refused; absent options are none', () => {
    expect('error' in normalizeDecisionOptions(['A', ' '])).toBe(true);
    expect('error' in normalizeDecisionOptions(['A', 'a'])).toBe(true);
    expect('error' in normalizeDecisionOptions('A')).toBe(true);
    expect(normalizeDecisionOptions(undefined)).toEqual({ options: [] });
  });

  test('derived briefs carry the effect too, and sanitize keeps a capped effect', () => {
    const b = deriveQuestionBrief({ question: 'Which? Local or UTC?', options: [{ label: 'UTC', description: 'Everyone is charged on the same calendar, whatever their time zone says today.' }] });
    expect(b.options[0].effect!.length).toBeLessThanOrEqual(DECISION_EFFECT_MAX);
    const s = sanitizeQuestionBrief({ options: [{ label: 'A', effect: 'x'.repeat(80) }] });
    expect(((s.options as Array<{ effect: string }>)[0].effect).length).toBeLessThanOrEqual(DECISION_EFFECT_MAX);
  });

  test('guidance asks for two options, names the decision and never offers Not now', () => {
    expect(QUESTION_BRIEF_GUIDANCE).toContain(DECISION_OPTIONS_GUIDANCE);
    expect(QUESTION_BRIEF_GUIDANCE).toContain(DECISION_TITLE_GUIDANCE);
    expect(DECISION_OPTIONS_GUIDANCE).toContain('two options by default');
    expect(DECISION_OPTIONS_GUIDANCE).toContain('Not now');
    expect(DECISION_TITLE_GUIDANCE).toContain('never "How should I proceed?"');
    expect(QUESTION_BRIEF_GUIDANCE).not.toMatch(/three options/i);
  });
});
