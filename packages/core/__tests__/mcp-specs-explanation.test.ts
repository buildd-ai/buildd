/**
 * A revision's explanation over MCP (Living Spec b7fc9316 R-15, AC-18):
 * create_draft and revise pass `explanation` to the API as given, the
 * contract text and the living-specs guidance tell an agent to write one, and
 * a revise refused because the explanation is fixed says so.
 * Storage and the coverage check are real-Postgres tested in
 * apps/web/tests/db/spec-revision-explanation.test.ts.
 */
import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000082';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const call = (api: unknown, params: Record<string, unknown>) => handleBuilddAction(api as ApiFn, 'manage_specs', params, ctx());
const EXPLANATION = { summary: 'Totals round to cents.', lines: { 'R-1': 'Rounds to the cent.', 'Out of scope': 'Drops refunds.' } };

describe('manage_specs explanation', () => {
  it('create_draft sends the explanation with the draft', async () => {
    const api = mock(async () => ({ spec: { id: SPEC, title: 'Checkout', version: 1, status: 'draft' }, duplicateCheck: null, suggestedParent: null, formatHints: null }));
    await call(api, { action: 'create_draft', title: 'Checkout', body: '# Checkout\n- R-1: x', explanation: EXPLANATION });
    const [, opts] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(opts.body)).explanation).toEqual(EXPLANATION);
  });

  it('revise sends it with the new revision', async () => {
    const api = mock(async () => ({ spec: { version: 3 }, revision: { revision: 2 }, unchanged: false }));
    await call(api, { action: 'revise', specId: SPEC, expectedVersion: 2, body: '# Checkout\n- R-1: y', explanation: EXPLANATION });
    const [endpoint, opts] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe(`/api/specs/${SPEC}`);
    expect(JSON.parse(String(opts.body)).explanation).toEqual(EXPLANATION);
  });

  it('AC-18: a revise refused because the explanation is fixed returns the reason, not a crash', async () => {
    const err = new Error(`API error: 409 - ${JSON.stringify({ error: 'Revision 2 is already written and its explanation cannot change.', code: 'explanation_immutable' })}`);
    const api = mock(async () => { throw err; });
    const r = await call(api, { action: 'revise', specId: SPEC, expectedVersion: 3, body: '# Checkout\n- R-1: y', explanation: EXPLANATION });
    expect(out(r)).toContain('explanation cannot change');
  });

  it('the contract and the guidance tell an agent to write one when it revises', () => {
    const contract = buildParamsDescription(['manage_specs']);
    expect(contract).toContain('explanation? (create_draft/revise');
    const guidance = readFileSync(join(import.meta.dir, '..', 'mcp-guidance', 'living-specs.md'), 'utf8');
    expect(guidance).toContain('Write an explanation with every revise');
    expect(guidance).toContain('explanation_immutable');
  });
});
