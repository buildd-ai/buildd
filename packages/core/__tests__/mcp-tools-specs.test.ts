import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, adminActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { SPEC_INLINE_BODY_MAX } from '../mcp-specs';
import { requiredScopeForAction } from '../token-scopes';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000051';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const spec = { id: SPEC, title: 'Checkout', scope: 'feature', status: 'draft', version: 2, headRevision: 2, bodyArtifactId: 'art-1' };
const out = (r: any) => String(r.content[0].text);

describe('manage_specs', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a worker-level action whose reads need tasks:read and writes tasks:write', () => {
    expect(workerActions).toContain('manage_specs');
    expect(adminActions as readonly string[]).not.toContain('manage_specs');
    expect(requiredScopeForAction('manage_specs', { action: 'get' })).toBe('tasks:read');
    expect(requiredScopeForAction('manage_specs', { action: 'revise' })).toBe('tasks:write');
  });

  it('list and create_draft default to the session workspace', async () => {
    api.mockResolvedValueOnce({ specs: [spec] });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'list' }, ctx()))).toContain('Checkout');
    expect(api.mock.calls[0][0]).toBe(`/api/specs?workspaceId=${WS}`);

    api.mockResolvedValueOnce({ spec: { ...spec, version: 1 } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout', body: 'R-1: x', scope: 'feature' }, ctx()));
    const [endpoint, opts] = api.mock.calls[1];
    expect([endpoint, opts.method]).toEqual(['/api/specs', 'POST']);
    expect(JSON.parse(opts.body)).toEqual({ workspaceId: WS, title: 'Checkout', body: 'R-1: x', scope: 'feature' });
    expect(r).toContain('Version: 1');
  });

  it('get inlines a short body with its requirement ids and history', async () => {
    api.mockResolvedValueOnce({ spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc' }, body: '# Checkout\nR-1: x', requirements: [{ id: 'R-1' }], revisions: [{ revision: 2, authorKind: 'agent', changeSummary: 'tighten' }, { revision: 1, authorKind: 'user' }] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC, revision: 2 }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/${SPEC}?revision=2`);
    expect(r).toContain('R-1: x');
    expect(r).toContain('Requirement ids: R-1');
    expect(r).toContain('r2 by agent: tighten');
    expect(r).toContain('expectedVersion 2');
  });

  it('get points a long body at bounded artifact reads instead of inlining it', async () => {
    const body = 'x'.repeat(SPEC_INLINE_BODY_MAX + 1);
    api.mockResolvedValueOnce({ spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc' }, body, requirements: [], revisions: [] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC }, ctx()));
    expect(r).not.toContain(body);
    expect(r).toContain('get_artifact { artifactId: "art-1", revision: 3, view: "outline" }');
  });

  it('a stale revise surfaces currentVersion and says how to recover, and writes are PATCHes', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"changed","code":"version_conflict","currentVersion":3}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'new' }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('currentVersion: 3');
    expect(out(r)).toContain('expectedVersion 3');
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method, JSON.parse(opts.body)]).toEqual([`/api/specs/${SPEC}`, 'PATCH', { expectedVersion: 2, body: 'new' }]);
  });

  it('revise requires expectedVersion; other API errors are not swallowed', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, body: 'b' }, ctx())).rejects.toThrow('expectedVersion');
    api.mockRejectedValueOnce(new Error('API error: 404 - {"error":"Spec not found"}'));
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 1, body: 'b' }, ctx())).rejects.toThrow('404');
  });

  it('relate PUTs the parent, passes null through to clear it, and reports a cycle refusal', async () => {
    api.mockResolvedValueOnce({ spec: { ...spec, parentSpecId: 'p-1' } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: 'p-1' }, ctx()))).toContain('Parent set');
    expect([api.mock.calls[0][0], api.mock.calls[0][1].method]).toEqual([`/api/specs/${SPEC}/parent`, 'PUT']);
    api.mockResolvedValueOnce({ spec: { ...spec, parentSpecId: null } });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: null }, ctx());
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ parentSpecId: null });
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"would form a cycle"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: 'p-2' }, ctx());
    expect([r.isError, out(r)]).toEqual([true, 'would form a cycle']);
  });

  it('refuses an unknown sub-action, and no param sets a status', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'publish', specId: SPEC }, ctx())).rejects.toThrow('action must be one of');
    expect(api).not.toHaveBeenCalled();
    const docs = buildParamsDescription(['manage_specs']);
    expect(docs).not.toMatch(/\bstatus\?/);
    expect(docs).toContain('a person\'s act');
  });

  it('approve POSTs the head revision and version; a write scope; an agent run gets the route\'s 403 back as an error', async () => {
    expect(requiredScopeForAction('manage_specs', { action: 'approve' })).toBe('tasks:write');
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC, expectedVersion: 2 }, ctx())).rejects.toThrow('revision');
    api.mockResolvedValueOnce({ spec: { ...spec, version: 3, approvedRevision: 2 }, revision: { revision: 2, contentHash: 'ab'.repeat(32) } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC, revision: 2, expectedVersion: 2 }, ctx()))).toContain('Approved: revision 2');
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method, JSON.parse(opts.body)]).toEqual([`/api/specs/${SPEC}/approve`, 'POST', { revision: 2, expectedVersion: 2 }]);
    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"Approving a spec is a person\'s decision"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC, revision: 2, expectedVersion: 2 }, ctx());
    expect([r.isError, out(r)]).toEqual([true, "Approving a spec is a person's decision"]);
  });

  it('submit POSTs the version, and a stale one surfaces currentVersion', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"changed","currentVersion":4}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'submit', specId: SPEC, expectedVersion: 2 }, ctx());
    expect([r.isError, out(r).includes('currentVersion: 4')]).toEqual([true, true]);
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual([`/api/specs/${SPEC}/submit`, { expectedVersion: 2 }]);
  });

  const TASK = '00000000-0000-4000-8000-0000000000c1';
  const HEAD = 'c'.repeat(40);
  const outcome = (o: string, reason: string) => ({ outcome: { outcome: o, reason, revision: 1, currentHeadSha: HEAD, criteria: [{ criterionId: 'R-1', verdict: o === 'fail' ? 'fail' : null, headSha: HEAD, stale: false }] } });

  it('outcome reads the task\'s governed outcome with a read scope; verdict POSTs one criterion at a head with a write scope', async () => {
    expect(requiredScopeForAction('manage_specs', { action: 'outcome' })).toBe('tasks:read');
    expect(requiredScopeForAction('manage_specs', { action: 'verdict' })).toBe('tasks:write');
    api.mockResolvedValueOnce(outcome('unverified', 'R-1 has no verdict'));
    const read = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'outcome', taskId: TASK }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/outcomes/${TASK}`);
    expect(read).toContain('Governed outcome: UNVERIFIED');
    expect(read).toContain('R-1: no verdict');

    api.mockResolvedValueOnce(outcome('fail', 'R-1 failed'));
    const rec = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'verdict', taskId: TASK, criterionId: 'R-1', verdict: 'fail', headSha: HEAD, evidenceRefs: [{ kind: 'file', ref: 'a.ts:3' }] }, ctx()));
    const [endpoint, opts] = api.mock.calls[1];
    expect([endpoint, opts.method, JSON.parse(opts.body)]).toEqual([`/api/specs/outcomes/${TASK}`, 'POST', { criterionId: 'R-1', verdict: 'fail', headSha: HEAD, evidenceRefs: [{ kind: 'file', ref: 'a.ts:3' }] }]);
    expect(rec).toContain('Recorded fail on R-1');
    expect(rec).toContain('Governed outcome: FAIL');
  });

  it('a refused verdict (a task grading itself) comes back as the route\'s error', async () => {
    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"a task never grades its own outcome"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'verdict', taskId: TASK, criterionId: 'R-1', verdict: 'pass', headSha: HEAD }, ctx());
    expect([r.isError, out(r)]).toEqual([true, 'a task never grades its own outcome']);
  });

  it('conflict POSTs two criteria of an approved revision as an advisory discrepancy', async () => {
    api.mockResolvedValueOnce({ discrepancyId: 'd-1' });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'conflict', specId: SPEC, revision: 1, criterionIds: ['R-1', 'R-2'], note: 'disagree' }, ctx()));
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual([`/api/specs/${SPEC}/conflicts`, { revision: 1, criterionIds: ['R-1', 'R-2'], note: 'disagree' }]);
    expect(r).toContain('advisory');
  });

  it('create_draft and revise pass repoRefs through; get lists the cited repo specs; a refused reference is the route error', async () => {
    const refs = [{ path: 'docs/specs/checkout.md', commitSha: 'c'.repeat(40) }];
    api.mockResolvedValueOnce({ spec: { ...spec, version: 1 } });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout', body: 'R-1: x', repoRefs: refs }, ctx());
    expect(JSON.parse(api.mock.calls[0][1].body).repoRefs).toEqual(refs);

    api.mockRejectedValueOnce(new Error('API error: 400 - {"error":"repoRefs: docs/nope.md does not exist at cccccccccccc; nothing was written"}'));
    const bad = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'R-1: x', repoRefs: [{ path: 'docs/nope.md', commitSha: 'c'.repeat(40) }] }, ctx());
    expect(bad.isError).toBe(true);
    expect(out(bad)).toContain('nothing was written');
    expect(JSON.parse(api.mock.calls[1][1].body).repoRefs).toEqual([{ path: 'docs/nope.md', commitSha: 'c'.repeat(40) }]);

    api.mockResolvedValueOnce({ spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc', repoRefs: refs }, body: 'R-1: x', requirements: [], revisions: [] });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC }, ctx()))).toContain(`docs/specs/checkout.md @ ${'c'.repeat(40)}`);
  });

  it('read_ref reads a cited repo spec at its commit, bounded, with a read scope', async () => {
    expect(requiredScopeForAction('manage_specs', { action: 'read_ref' })).toBe('tasks:read');
    api.mockResolvedValueOnce({ path: 'docs/specs/checkout.md', commitSha: 'c'.repeat(40), revision: 2, read: { view: 'grep', chars: 900, pattern: 'total', matches: [{ line: 3, offset: 40, text: 'R-1: the total' }], truncated: false } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'read_ref', specId: SPEC, path: 'docs/specs/checkout.md', view: 'grep', grep: 'total' }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/${SPEC}/repo-ref?path=docs%2Fspecs%2Fcheckout.md&view=grep&grep=total`);
    expect(r).toContain('L3: R-1: the total');
    expect(r).toContain('cited by revision 2');

    api.mockRejectedValueOnce(new Error('API error: 404 - {"error":"Revision 2 does not cite docs/other.md"}'));
    const miss = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'read_ref', specId: SPEC, path: 'docs/other.md' }, ctx());
    expect([miss.isError, out(miss)]).toEqual([true, 'Revision 2 does not cite docs/other.md']);
  });
});
