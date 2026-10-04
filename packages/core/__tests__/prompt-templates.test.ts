import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  installPrompts,
  promptFallbackCounts,
  promptShapeMismatch,
  renderTemplate,
  resetPrompts,
  resolvePromptTemplate,
  resolvePromptValue,
  resolvePromptValueEntry,
  templateMismatch,
  type ActivePrompt,
} from '../prompts';
import { promptContentHash } from '../prompts-source';
import { promptedQuestions, resetPromptedQuestionsCache } from '../prompted-decision';

const row = (id: string, version: number, body: string): ActivePrompt => ({ id, version, body, contentHash: promptContentHash(body) });

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetPrompts();
  resetPromptedQuestionsCache();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  resetPrompts();
  warn.mockRestore();
});

const TEMPLATE = 'Review PR #{{prNumber}} on {{repo}}.\n{{body}}';

describe('template prompts', () => {
  it('renders in one pass: a value carrying {{x}} is inserted verbatim', () => {
    expect(renderTemplate(TEMPLATE, { prNumber: 7, repo: 'o/r', body: 'says {{repo}}' })).toBe('Review PR #7 on o/r.\nsays {{repo}}');
  });

  it('with no row, the public template is filled', () => {
    expect(resolvePromptTemplate('t.review', TEMPLATE, { prNumber: 7, repo: 'o/r', body: 'x' })).toBe('Review PR #7 on o/r.\nx');
    expect(promptFallbackCounts()['t.review']).toEqual({ missing: 1, invalid: 0 });
  });

  it('an active row with the same placeholders replaces the text', () => {
    installPrompts([row('t.review', 2, 'PRIVATE {{repo}}#{{prNumber}}: {{body}}')]);
    expect(resolvePromptTemplate('t.review', TEMPLATE, { prNumber: 7, repo: 'o/r', body: 'x' })).toBe('PRIVATE o/r#7: x');
  });

  it('a row that drops a required placeholder is rejected, counted, and the public text runs', () => {
    installPrompts([row('t.review', 2, 'PRIVATE {{repo}}: {{body}}')]);
    expect(resolvePromptTemplate('t.review', TEMPLATE, { prNumber: 7, repo: 'o/r', body: 'x' })).toBe('Review PR #7 on o/r.\nx');
    expect(resolvePromptTemplate('t.review', TEMPLATE, { prNumber: 7, repo: 'o/r', body: 'x' })).toBe('Review PR #7 on o/r.\nx');
    expect(promptFallbackCounts()['t.review'].invalid).toBe(2);
    // Logged once per row version, naming the placeholder, never the text.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('{{prNumber}}');
    expect(String(warn.mock.calls[0][0])).not.toContain('PRIVATE');
  });

  it('a row that adds an unknown placeholder is rejected', () => {
    expect(templateMismatch(TEMPLATE, '{{prNumber}} {{repo}} {{body}} {{secret}}')).toContain('unknown placeholder {{secret}}');
  });
});

describe('structured prompts', () => {
  const DEFAULT = { phases: { build: ['Monitor builders'], idle: ['Wait'] }, question: 'Is criteria[{{i}}] met?' };

  it('accepts a body of the same shape (arrays may change length)', () => {
    const body = { phases: { build: ['A', 'B'], idle: ['C'] }, question: 'Private: criteria[{{i}}]?' };
    installPrompts([row('t.shape', 1, JSON.stringify(body))]);
    expect(resolvePromptValue('t.shape', DEFAULT)).toEqual(body);
    expect(resolvePromptValueEntry('t.shape', DEFAULT).version).toBe(1);
  });

  it('rejects a body with a missing key, an empty list, a dropped placeholder or bad JSON', () => {
    expect(promptShapeMismatch(DEFAULT, { phases: { build: ['A'] }, question: 'criteria[{{i}}]' })).toContain('keys differ');
    expect(promptShapeMismatch(DEFAULT, { phases: { build: [], idle: ['C'] }, question: 'criteria[{{i}}]' })).toContain('must not be empty');
    expect(promptShapeMismatch(DEFAULT, { phases: { build: ['A'], idle: ['C'] }, question: 'no index' })).toContain('{{i}}');
    for (const body of ['{not json', JSON.stringify({ phases: {}, question: 'x {{i}}' })]) {
      resetPrompts();
      installPrompts([row('t.shape', 1, body)]);
      expect(resolvePromptValue('t.shape', DEFAULT)).toBe(DEFAULT);
      expect(promptFallbackCounts()['t.shape'].invalid).toBe(1);
    }
  });
});

describe('promptedQuestions', () => {
  const Q = {
    pick: {
      type: 'choice' as const,
      instructions: { question: 'Which?', rule: 'Follow the definitions.' },
      criteria: { a: { what: 'A', not_for: 'B' }, b: { what: 'B', not_for: 'A' } },
    },
  };

  it('uses the active row and names its version', () => {
    const body = { pick: { ...Q.pick, instructions: { question: 'Private which?', rule: 'Private rule.' } } };
    installPrompts([row('t.q', 4, JSON.stringify(body))]);
    const r = promptedQuestions('t.q', Q, 'x1');
    expect(r.questions.pick.instructions.question).toBe('Private which?');
    expect(r.promptVersion).toBe('x1+p4');
  });

  it('rejects a row that changes a label and keeps the public questions', () => {
    const body = { pick: { ...Q.pick, criteria: { a: Q.pick.criteria.a, c: Q.pick.criteria.b } } };
    installPrompts([row('t.q', 4, JSON.stringify(body))]);
    const r = promptedQuestions('t.q', Q, 'x1');
    expect(r.questions).toBe(Q);
    expect(r.promptVersion).toBe('x1');
    expect(promptFallbackCounts()['t.q'].invalid).toBe(1);
  });
});
