import { describe, expect, test } from 'bun:test';
import { classifyRevisionRisk } from './revision-risk';

const BASE = [
  '# Checkout',
  'Intro line about the page.',
  '## Requirements',
  'R-1: Totals are in the shopper currency.',
  'R-2: Rates come from the rates service.',
  '- AC-1 Given EUR, the total reads €.',
  '## Notes',
  'Some background prose.',
  '',
].join('\n');

const level = (from: string | null, to: string) => classifyRevisionRisk(from, to).level;
const swap = (s: string, a: string, b: string) => s.replace(a, b);

describe('classifyRevisionRisk', () => {
  test('a first revision needs judgement', () => {
    expect(level(null, BASE)).toBe('judgement');
  });
  test('identical bodies are low-risk', () => {
    expect(classifyRevisionRisk(BASE, BASE)).toEqual({ level: 'low-risk', reasons: [] });
  });
  test('rewording non-criterion prose is low-risk', () => {
    expect(level(BASE, swap(BASE, 'Some background prose.', 'Some extra background prose, reworded.'))).toBe('low-risk');
    expect(level(BASE, swap(BASE, 'Intro line about the page.', 'An intro line about this page.'))).toBe('low-risk');
  });
  test('whitespace and blank-line edits are low-risk', () => {
    expect(level(BASE, swap(BASE, 'Some background prose.', 'Some background prose.\n\n'))).toBe('low-risk');
  });
  test('a changed criterion needs judgement and names it', () => {
    const r = classifyRevisionRisk(BASE, swap(BASE, 'rates service', 'cache'));
    expect(r.level).toBe('judgement');
    expect(r.reasons[0]).toBe('Criterion R-2 changed');
  });
  test('an added criterion needs judgement', () => {
    const r = classifyRevisionRisk(BASE, swap(BASE, '## Notes', 'R-3: A new rule holds.\n## Notes'));
    expect(r.level).toBe('judgement');
    expect(r.reasons).toContain('Criterion R-3 was added');
  });
  test('a removed criterion needs judgement', () => {
    const r = classifyRevisionRisk(BASE, swap(BASE, 'R-2: Rates come from the rates service.\n', ''));
    expect(r.level).toBe('judgement');
    expect(r.reasons).toContain('Criterion R-2 was removed');
  });
  test('a changed check or acceptance criterion needs judgement', () => {
    expect(level(BASE, swap(BASE, 'the total reads €', 'the total reads $'))).toBe('judgement');
  });
  test('moving a criterion under another heading needs judgement', () => {
    expect(level(BASE, swap(BASE.replace('R-2: Rates come from the rates service.\n', ''), 'Some background prose.', 'Some background prose.\nR-2: Rates come from the rates service.'))).toBe('judgement');
  });
  test('credential, permission and approval wording in prose needs judgement', () => {
    for (const word of ['the API key is stored', 'any member may approve', 'owners get admin access', 'the OAuth token is rotated', 'permissions are checked', 'a passkey is required']) {
      expect(level(BASE, swap(BASE, 'Some background prose.', `Some background prose; ${word}.`))).toBe('judgement');
    }
  });
  test('removing credential wording also needs judgement', () => {
    const withKey = swap(BASE, 'Some background prose.', 'Never share the secret.');
    expect(level(withKey, BASE)).toBe('judgement');
  });
  test('sensitive words that did not change do not count', () => {
    const withKey = swap(BASE, 'Some background prose.', 'Approvers hold the token.');
    expect(level(withKey, swap(withKey, 'Intro line about the page.', 'A reworded intro.'))).toBe('low-risk');
  });
  test('a change inside a code fence needs judgement', () => {
    const fenced = swap(BASE, 'Some background prose.', '```\nretry = 3\n```');
    expect(level(fenced, swap(fenced, 'retry = 3', 'retry = 5'))).toBe('judgement');
  });
  test('a change in front matter needs judgement', () => {
    const fm = `---\ntitle: A\n---\n${BASE}`;
    expect(level(fm, fm.replace('title: A', 'title: B'))).toBe('judgement');
  });
  test('a heading change needs judgement', () => {
    expect(level(BASE, swap(BASE, '## Notes', '## Background'))).toBe('judgement');
  });
  test('a prose line that names a criterion needs judgement', () => {
    expect(level(BASE, swap(BASE, 'Some background prose.', 'Some background prose, see R-1.'))).toBe('judgement');
  });
  test('reasons are capped at three and low-risk has none', () => {
    const r = classifyRevisionRisk(BASE, 'R-9: new.\nR-8: new.\nR-7: new.\nR-6: new.');
    expect(r.reasons.length).toBe(3);
  });
  test('empty to empty body and unparseable text do not throw', () => {
    expect(level('', '')).toBe('low-risk');
    expect(level('', 'x')).toBe('low-risk');
  });
});
