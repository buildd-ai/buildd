/**
 * getActiveClaudeSecretId names the credential an auth failure is recorded
 * against. A team's Anthropic API key may sit in canonical storage
 * (`inference_key` + label `anthropic`, which agent runs read) or in the
 * legacy `anthropic_api_key`; both are found, canonical first, and a personal
 * row is never named. WHERE clauses are rendered through PgDialect so the
 * filter itself is observable.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const render = (f: any) => dialect.sqlToQuery(f);

type Row = { id: string; purpose: string; label?: string | null; userId?: string | null };
let rows: Row[] = [];
const findMany = mock(async (_args: any) => rows);
mock.module('@buildd/core/db', () => ({ db: { query: { secrets: { findMany } } } }));

const { getActiveClaudeSecretId } = await import('./credential-health');

beforeEach(() => {
  rows = [];
  findMany.mockClear();
});

describe('getActiveClaudeSecretId', () => {
  it('reads canonical and legacy Anthropic key storage, team rows only', async () => {
    await getActiveClaudeSecretId('t-1', null);
    const { sql, params } = render(findMany.mock.calls[0][0].where);
    expect(params).toContain('inference_key');
    expect(params).toContain('anthropic_api_key');
    expect(params).toContain('oauth_token');
    expect(sql).toContain('"user_id" is null');
  });

  it('names a canonical-only team key', async () => {
    rows = [{ id: 'canon', purpose: 'inference_key', label: 'anthropic' }];
    expect(await getActiveClaudeSecretId('t-1')).toBe('canon');
  });

  it('prefers canonical over legacy, and a seat token over either', async () => {
    rows = [
      { id: 'legacy', purpose: 'anthropic_api_key' },
      { id: 'canon', purpose: 'inference_key', label: 'anthropic' },
    ];
    expect(await getActiveClaudeSecretId('t-1')).toBe('canon');
    rows = [...rows, { id: 'seat', purpose: 'oauth_token' }];
    expect(await getActiveClaudeSecretId('t-1')).toBe('seat');
  });

  it('never names another provider\'s key or a personal row', async () => {
    rows = [
      { id: 'or', purpose: 'inference_key', label: 'openrouter' },
      { id: 'oa', purpose: 'inference_key', label: 'openai' },
      { id: 'mine', purpose: 'inference_key', label: 'anthropic', userId: 'u-1' },
    ];
    expect(await getActiveClaudeSecretId('t-1')).toBeNull();
  });

  it('a legacy-only team still gets its legacy key', async () => {
    rows = [{ id: 'legacy', purpose: 'anthropic_api_key' }];
    expect(await getActiveClaudeSecretId('t-1')).toBe('legacy');
  });
});
