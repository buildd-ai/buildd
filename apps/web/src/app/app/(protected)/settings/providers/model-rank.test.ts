import { describe, expect, it } from 'bun:test';
import { rankModelOptions } from './model-rank';

const opt = (label: string) => ({ value: label, label });
const labels = (xs: Array<{ label: string }>) => xs.map((x) => x.label);

describe('rankModelOptions', () => {
  const IDS = [
    'bedrock/deepseek.r1-v1:0',
    'fireworks_ai/deepseek-v4p1-flash',
    'deepseek-v4p1',
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'openrouter/anthropic/claude-haiku-4-5',
  ].map(opt);

  it('an exact id comes first, then ids that start with the query', () => {
    expect(labels(rankModelOptions(IDS, 'claude-haiku-4-5')).slice(0, 2)).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5-20251001']);
  });

  it('is case-insensitive', () => {
    expect(labels(rankModelOptions(IDS, 'CLAUDE-HAIKU-4-5'))[0]).toBe('claude-haiku-4-5');
  });

  it('a whole-id prefix beats a match after a provider prefix, which beats a scattered one', () => {
    expect(labels(rankModelOptions(IDS, 'deepseek'))).toEqual([
      'deepseek-v4p1',
      'bedrock/deepseek.r1-v1:0',
      'fireworks_ai/deepseek-v4p1-flash',
    ]);
  });

  it('a model name after a provider prefix counts as exact', () => {
    expect(labels(rankModelOptions(IDS, 'deepseek-v4p1-flash'))[0]).toBe('fireworks_ai/deepseek-v4p1-flash');
  });

  it('drops what does not match and keeps the input order for ties', () => {
    expect(labels(rankModelOptions(IDS, 'zzz'))).toEqual([]);
    expect(labels(rankModelOptions(IDS, ''))).toEqual(labels(IDS));
  });

  it('still finds the "send as is" option by its words', () => {
    const withAsIs = [{ value: '__as is__', label: 'Send as is', description: 'The id buildd asks for, unchanged' }, ...IDS];
    expect(labels(rankModelOptions(withAsIs, 'as is'))[0]).toBe('Send as is');
  });
});

