import { describe, expect, it } from 'bun:test';
import { mappingSummary, prefillSource } from './endpoint-summary';

const row = (model: string, sent: string) => ({ model, tiers: [], sent });

describe('mappingSummary', () => {
  it('groups the models by the name sent, most first', () => {
    const mapping = [
      row('claude-opus-5', 'fireworks_ai/deepseek-v4p1-flash'),
      row('claude-sonnet-5', 'fireworks_ai/deepseek-v4p1-flash'),
      row('claude-haiku-4-5-20251001', 'claude-haiku-4-5'),
      row('claude-fable-5-1', 'fireworks_ai/deepseek-v4p1-flash'),
    ];
    expect(mappingSummary(mapping)).toBe('3 models → fireworks_ai/deepseek-v4p1-flash, 1 → claude-haiku-4-5');
  });

  it('says how many go unchanged', () => {
    expect(mappingSummary([row('claude-sonnet-5', 'claude-sonnet-5'), row('claude-haiku-4-5-20251001', 'claude-haiku-4-5')]))
      .toBe('1 model sent as is, 1 → claude-haiku-4-5');
    expect(mappingSummary([row('a', 'x'), row('b', 'b'), row('c', 'c')])).toBe('2 models sent as is, 1 → x');
  });

  it('is empty for no mapping', () => {
    expect(mappingSummary([])).toBe('');
    expect(mappingSummary(undefined)).toBe('');
  });
});

describe('prefillSource: where a new workspace override starts from', () => {
  const team = { scope: 'team' as const, workspaceId: null, lastVerifiedAt: '2026-01-01T00:00:00.000Z', models: { a: 'x' } };
  const older = { scope: 'workspace' as const, workspaceId: 'ws-1', lastVerifiedAt: '2026-01-02T00:00:00.000Z', models: { a: 'y' } };
  const newer = { scope: 'workspace' as const, workspaceId: 'ws-2', lastVerifiedAt: '2026-01-03T00:00:00.000Z', models: { a: 'z' } };

  it('the team endpoint, when there is one', () => {
    expect(prefillSource([older, team, newer], 'ws-3')).toBe(team);
  });

  it('else the most recently checked workspace override', () => {
    expect(prefillSource([older, newer], 'ws-3')).toBe(newer);
    expect(prefillSource([{ ...older, lastVerifiedAt: null }, { ...newer, lastVerifiedAt: null }], 'ws-3')?.workspaceId).toBe('ws-2');
  });

  it('never the workspace\'s own row, and nothing for an empty team', () => {
    expect(prefillSource([older], 'ws-1')).toBeNull();
    expect(prefillSource([], 'ws-1')).toBeNull();
  });
});
