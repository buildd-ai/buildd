import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, adminActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { SPEC_INLINE_BODY_MAX, WORKSPACE_SPEC_OPS } from '../mcp-specs';
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

  // Regression: organize shipped resolving no workspace, so over MCP it always
  // failed with "workspaceId is required" even in a workspace-bound session.
  it('every sub-action that needs a workspace gets the session one', async () => {
    for (const action of WORKSPACE_SPEC_OPS) {
      api.mockReset();
      api.mockResolvedValue({ specs: [], spec: { ...spec, version: 1 }, mode: 'sweep', dryRun: true, scanned: 0, remaining: 0, skipped: 0, groups: [] });
      const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action, title: 'T', body: 'R-1: x' }, ctx());
      expect(r.isError ?? false).toBe(false);
      const [endpoint, opts] = api.mock.calls[0];
      expect(`${endpoint} ${opts?.body ?? ''}`).toContain(WS);
    }
    expect(WORKSPACE_SPEC_OPS).toContain('organize');
  });

  it('a taxonomy dry run says which produced it, and lists the specs it left for a person', async () => {
    const proposal = { product: { title: 'Shop' }, areas: [{ key: 'payments', title: 'Payments', charter: 'Specs about payments.', members: [{ specId: 's1', title: 'Refunds' }] }], unplaced: [{ specId: 's9', title: 'Test spec' }] };
    api.mockResolvedValueOnce({ mode: 'taxonomy', dryRun: true, specs: 2, proposal, proposedBy: { source: 'words', label: 'word-based fallback, no model available', reason: 'this team has no decision-model key' } });
    const words = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'organize' }, ctx()));
    expect(words).toContain('Proposed by the word-based fallback, no model available (this team has no decision-model key).');
    expect(words).toContain('Left for a person to place (1): Test spec (s9)');
    api.mockResolvedValueOnce({ mode: 'taxonomy', dryRun: true, specs: 2, proposal, proposedBy: { source: 'model', model: 'typesafe/jev-1' } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'organize' }, ctx()))).toContain('Proposed by the decision model (typesafe/jev-1).');
  });

  it('create_draft and get return the spec page URL, from appBaseUrl when set and buildd.dev otherwise', async () => {
    const run = async (action: string, c: ActionContext) => {
      api.mockResolvedValueOnce(action === 'get'
        ? { spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc' }, body: 'x', requirements: [], revisions: [] }
        : { spec: { ...spec, version: 1 } });
      return out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action, specId: SPEC, title: 'Checkout', body: 'R-1: x' }, c));
    };
    for (const action of ['create_draft', 'get']) {
      expect(await run(action, ctx())).toContain(`Spec URL: https://buildd.dev/app/specs/${SPEC}`);
      expect(await run(action, ctx({ appBaseUrl: 'https://app.example.test/' }))).toContain(`Spec URL: https://app.example.test/app/specs/${SPEC}`);
    }
  });

  it('revise, submit and approve also return the spec page URL', async () => {
    const url = `Spec URL: https://buildd.dev/app/specs/${SPEC}`;
    api.mockResolvedValueOnce({ spec: { ...spec, version: 3 }, revision: { revision: 3 }, unchanged: false });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'n' }, ctx()))).toContain(url);
    api.mockResolvedValueOnce({ spec, revision: { revision: 2 } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'submit', specId: SPEC, expectedVersion: 2 }, ctx()))).toContain(url);
    api.mockResolvedValueOnce({ spec, revision: { revision: 2, contentHash: 'abc' } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC, expectedVersion: 2, revision: 2 }, ctx()))).toContain(url);
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

  it('a revise refused because the body moved outside a revise gives the reason, not retry advice', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"The spec body was changed outside a spec revise","code":"spec_body_moved"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'new' }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('changed outside a spec revise');
    expect(out(r)).not.toContain('expectedVersion');
  });

  it('revise with section or heading sends only that section, byte for byte, and says which section changed', async () => {
    api.mockResolvedValueOnce({ spec: { ...spec, version: 3 }, revision: { revision: 3 }, unchanged: false });
    const text = '## Caching\nR-2: 5 minutes.\n\n';
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, section: 's3', body: text }, ctx()));
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method]).toEqual([`/api/specs/${SPEC}`, 'PATCH']);
    expect(JSON.parse(opts.body)).toEqual({ expectedVersion: 2, section: 's3', body: text });
    expect(r).toContain('section s3');
    api.mockResolvedValueOnce({ spec: { ...spec, version: 3 }, revision: { revision: 3 }, unchanged: false });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, heading: 'Caching', body: text }, ctx());
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ expectedVersion: 2, heading: 'Caching', body: text });
  });

  // R-48 / AC-36: the server's formatHints come back as one gentle Tip line; the write still happened.
  it('create_draft and revise show formatHints as one Tip line, and no line when there are none', async () => {
    const hints = [
      { kind: 'diagram', line: 3, message: 'The 5 numbered steps at line 3 read as a flow.' },
      { kind: 'table', line: 9, message: 'The 3 parallel list lines at line 9 compare like a table.' },
    ];
    api.mockResolvedValueOnce({ spec: { ...spec, version: 1 }, formatHints: hints });
    const created = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout', body: '1. a\n2. b\n3. c\n4. d\n5. e' }, ctx()));
    expect(created).toContain('Spec draft created');
    const tips = created.split('\n').filter((l) => l.startsWith('Tip: '));
    expect(tips).toHaveLength(1);
    expect(tips[0]).toContain('read as a flow');
    expect(tips[0]).toContain('compare like a table');
    expect(tips[0]).toContain('living-specs');

    api.mockResolvedValueOnce({ spec: { ...spec, version: 3 }, revision: { revision: 3 }, unchanged: false, formatHints: hints.slice(0, 1) });
    const revised = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'n' }, ctx()));
    expect(revised).toContain('Revised: revision 3');
    expect(revised).toMatch(/^Tip: .*read as a flow/m);

    api.mockResolvedValueOnce({ spec: { ...spec, version: 1 }, formatHints: [] });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'T', body: 'R-1 x' }, ctx()))).not.toContain('Tip:');
  });

  it('the long help for create_draft and revise points at tables, diagrams and the guidance topic', () => {
    const d = buildParamsDescription(workerActions);
    const specs = d.slice(d.indexOf('- manage_specs:'));
    expect(specs.slice(0, specs.indexOf('\n- ', 2))).toMatch(/table[\s\S]*mermaid[\s\S]*living-specs/);
  });

  it('the long help documents section revise', () => {
    expect(buildParamsDescription(workerActions)).toMatch(/manage_specs[\s\S]*section\?/);
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

  it('approve from an OAuth session returns the confirmation link and says nothing is approved yet', async () => {
    const confirmUrl = `https://buildd.dev/app/specs/${SPEC}/approve?request=tok`;
    api.mockResolvedValueOnce({ spec: { ...spec, version: 2 }, pending: { confirmUrl, revision: 2, expiresAt: '2026-10-12T20:00:00.000Z' } });
    const text = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC, revision: 2, expectedVersion: 2 }, ctx()));
    expect(text).toContain('Not approved yet');
    expect(text).toContain(confirmUrl);
    expect(text).not.toContain('Approved:');
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

  it('create_draft passes the duplicate override and shows overlaps, a check that did not run, and a suggested parent', async () => {
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'Basket', version: 1, status: 'draft' }, duplicateCheck: { ran: true, warnings: [{ specId: 'cart-id', title: 'Cart', relation: 'overlap', p: 0.82 }] }, suggestedParent: { specId: 'shop-id', title: 'Shop', reason: 'Closest product by what it asks for' } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Basket', body: 'x', distinctBecause: 'B2B quotes, not the cart' }, ctx()));
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({ distinctBecause: 'B2B quotes, not the cart' });
    expect(r).toContain('Cart (cart-id): overlap, p 0.82');
    expect(r).toContain('Suggested parent: "Shop" (shop-id), closest product by what it asks for.');
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'B', version: 1, status: 'draft' }, duplicateCheck: { ran: false, reason: 'this team has no decision-model key' }, suggestedParent: null });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'B', body: 'x' }, ctx()))).toContain('Duplicate check did not run: this team has no decision-model key.');
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"This spec looks like a duplicate of \\"Cart\\"","code":"spec_duplicate"}'));
    const refused: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'C', body: 'x' }, ctx());
    expect(refused.isError).toBe(true);
  });

  // Living Specs Slice 12: the mission's selected outcome spec, judged on the integrated target.
  it('with missionId, outcome and verdict read and record mission-level verdicts', async () => {
    const MISSION = '00000000-0000-4000-8000-0000000000aa';
    const standing = { verdict: 'UNVERIFIED', evidence: 'One of two pass on aaaaaaa. R-2 has no verdict.', targetSha: 'a'.repeat(40), standings: [{ criterionId: 'R-1', standing: 'pass', headSha: 'a'.repeat(40) }, { criterionId: 'R-2', standing: 'missing', headSha: null }] };
    api.mockResolvedValueOnce({ outcomes: [{ criterion: { revision: 3, label: 'Spec "Overview" revision 3' }, standing }] });
    const read = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'outcome', missionId: MISSION }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/mission-outcomes/${MISSION}`);
    expect(read).toContain('Spec "Overview" revision 3 at aaaaaaaaaaaa: UNVERIFIED');
    expect(read).toContain('R-2: missing');

    api.mockResolvedValueOnce({ verdictId: 'v1', standing });
    const rec = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'verdict', missionId: MISSION, criterionId: 'R-1', verdict: 'pass', headSha: HEAD, reaffirms: 'v0' }, ctx()));
    const [endpoint, opts] = api.mock.calls[1];
    expect([endpoint, opts.method, JSON.parse(opts.body)]).toEqual([`/api/specs/mission-outcomes/${MISSION}`, 'POST', { criterionId: 'R-1', verdict: 'pass', headSha: HEAD, reaffirms: 'v0' }]);
    expect(rec).toContain('Recorded pass on R-1 at the integrated target');

    api.mockRejectedValueOnce(Object.assign(new Error('API error: 403 - {"error":"A mission-level verdict is recorded by a person or by the mission\'s final verification task."}'), {}));
    const refused: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'verdict', missionId: MISSION, criterionId: 'R-1', verdict: 'pass', headSha: HEAD }, ctx());
    expect(refused.isError).toBe(true);
  });

  it('a visual verdict sends what the audit captured instead of a head', async () => {
    api.mockResolvedValueOnce(outcome('unverified', 'AC-1 has no verdict'));
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'verdict', taskId: TASK, checker: 'visual', criterionId: 'AC-1', verdict: 'pass', capturedSha: HEAD, screenshotIds: ['s-1'], headSha: 'ignored' }, ctx());
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, JSON.parse(opts.body)]).toEqual([`/api/specs/outcomes/${TASK}`, { checker: 'visual', criterionId: 'AC-1', verdict: 'pass', capturedSha: HEAD, screenshotIds: ['s-1'] }]);
  });

  it('comment posts an anchor on a revision; comments lists states; reading needs only read scope', async () => {
    expect(requiredScopeForAction('manage_specs', { action: 'comments' })).toBe('tasks:read');
    expect(requiredScopeForAction('manage_specs', { action: 'comment' })).toBe('tasks:write');
    api.mockResolvedValueOnce({ comment: { id: 'c-1', anchor: { kind: 'criterion', id: 'AC-2', label: 'AC-2' }, madeOnRevision: 3 } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'comment', specId: SPEC, criterion: 'AC-2', body: 'Which currency?', revision: 3 }, ctx()));
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual([`/api/specs/${SPEC}/comments`, { anchor: { criterion: 'AC-2' }, body: 'Which currency?', revision: 3 }]);
    expect(r).toContain('Comment c-1 added on AC-2 of revision 3');
    api.mockResolvedValueOnce({ revision: 4, comments: [{ id: 'c-1', anchor: { kind: 'criterion', id: 'AC-2', label: 'AC-2' }, body: 'Which currency?', author: { kind: 'agent' }, state: 'outdated', madeOnRevision: 3, parentCommentId: null }] });
    const list = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'comments', specId: SPEC, revision: 4 }, ctx()));
    expect(api.mock.calls[1][0]).toBe(`/api/specs/${SPEC}/comments?revision=4`);
    expect(list).toContain('[outdated] AC-2 (r3, agent, c-1): Which currency?');
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

  it('attach_provisional POSTs the revision and tasks, lists each result, and passes an agent run\'s 403 through', async () => {
    const T = '00000000-0000-4000-8000-0000000000d1';
    api.mockResolvedValueOnce({ revision: 2, provisional: true, results: [{ taskId: T, attached: true }], regraded: [] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attach_provisional', specId: SPEC, revision: 2, taskIds: [T] }, ctx()));
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual([`/api/specs/${SPEC}/provisional`, { revision: 2, taskIds: [T] }]);
    expect(r).toContain(`${T}: attached`);
    expect(r).toContain('provisionally');

    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"an agent run cannot attach work"}'));
    const refused: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'attach_provisional', specId: SPEC, revision: 2, taskIds: [T] }, ctx());
    expect([refused.isError, out(refused)]).toEqual([true, 'an agent run cannot attach work']);
  });

  it('import is a dry run unless told otherwise, in the session workspace, and lists the files by area with what was skipped', async () => {
    expect(WORKSPACE_SPEC_OPS).toContain('import');
    api.mockResolvedValueOnce({
      dryRun: true, repo: 'acme/app', commitSha: 'a'.repeat(40), counts: { create: 1, reimport: 0, skip: 1 },
      byArea: [{ area: 'Billing', areaSpecId: SPEC, proposed: false, count: 1 }],
      files: [
        { path: 'docs/specs/invoices.md', action: 'create', spec: { title: 'Invoices' }, area: { specId: SPEC, title: 'Billing', proposed: false }, provenance: { commitSha: 'a'.repeat(40), prNumber: 12 }, duplicates: [{ specId: 'x1', title: 'Old invoices', relation: 'duplicate', p: 0.95 }] },
        { path: 'docs/specs/INDEX.md', action: 'skip', reason: 'meta_file', message: 'INDEX.md is generated', area: null },
      ],
    });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'import' }, ctx()));
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual(['/api/specs/import', { workspaceId: WS }]);
    expect(r).toContain('Dry run (nothing written) from acme/app@aaaaaaa');
    expect(r).toContain('create: Invoices from docs/specs/invoices.md, last changed in #12');
    expect(r).toContain('possible duplicate of "Old invoices"');
    expect(r).toContain('docs/specs/INDEX.md: meta_file');

    api.mockResolvedValueOnce({ dryRun: false, files: [], counts: { create: 0, reimport: 0, skip: 0 }, byArea: [] });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'import', dryRun: false, paths: ['docs/specs/invoices.md'] }, ctx());
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ workspaceId: WS, dryRun: false, paths: ['docs/specs/invoices.md'] });
  });

  it('import pages: limit, cursor and attach_provenance pass through, and the text says how many files remain and the exact call to continue', async () => {
    api.mockResolvedValueOnce({
      dryRun: true, repo: 'acme/app', commitSha: 'a'.repeat(40), counts: { create: 0, reimport: 0, exists: 1, skip: 0 }, limit: 15, remaining: 79, nextCursor: 'CUR123',
      byArea: [],
      files: [
        { path: 'docs/specs/task-page.md', action: 'exists', specId: SPEC, spec: { title: 'Task Page' }, area: null, existing: { specId: SPEC, title: 'Task Page', url: `https://buildd.dev/app/specs/${SPEC}`, matchedBy: 'title' } },
      ],
    });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'import', limit: 15, attach_provenance: true }, ctx()));
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ workspaceId: WS, limit: 15, attachProvenance: true });
    expect(r).toContain('1 already in buildd');
    expect(r).toContain(`exists: docs/specs/task-page.md is "Task Page" (https://buildd.dev/app/specs/${SPEC}, matched by title)`);
    expect(r).toContain('79 file(s) remain');
    expect(r).toContain('manage_specs { action: "import", dryRun: true, limit: 15, attach_provenance: true, cursor: "CUR123" }');

    api.mockResolvedValueOnce({ dryRun: false, files: [], counts: { create: 0, reimport: 0, exists: 0, skip: 0 }, byArea: [], remaining: 0, nextCursor: null });
    const last = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'import', dryRun: false, cursor: 'CUR123' }, ctx()));
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ workspaceId: WS, dryRun: false, cursor: 'CUR123' });
    expect(last).not.toContain('remain');
  });

  it('import text shows each file once, the classifier\'s suggestion for an Unfiled one, the fallback label, and a related spec as an explicit attach_to', async () => {
    const REL = '33333333-3333-4333-8333-333333333333';
    api.mockResolvedValueOnce({
      dryRun: true, repo: 'acme/app', commitSha: 'a'.repeat(40), counts: { create: 3, reimport: 0, exists: 1, skip: 0 },
      byArea: [
        { area: 'Unfiled', areaSpecId: null, proposed: false, count: 2, by: null },
        { area: 'Tasks and missions', areaSpecId: SPEC, proposed: false, count: 1, by: 'domain' },
      ],
      files: [
        { path: 'docs/specs/task-page.md', action: 'exists', specId: SPEC, spec: { title: 'Task Page' }, area: null, existing: { specId: SPEC, title: 'Task Page', url: `https://buildd.dev/app/specs/${SPEC}`, matchedBy: 'title' } },
        { path: 'docs/specs/decision-kinds.md', action: 'create', spec: { title: 'Decision Kinds' }, area: null, suggestion: { specId: 'd1', title: 'Decisions', answer: 'area', p: 0.8 }, placement: { by: 'classifier' } },
        { path: 'docs/specs/claim-ordering.md', action: 'create', spec: { title: 'Claim Ordering' }, area: null, related: [{ specId: REL, title: 'Claim routing overview', url: `https://buildd.dev/app/specs/${REL}` }], placement: { by: 'classifier' }, suggestion: { specId: null, title: 'Unsure', answer: 'unsure', p: 0.4 } },
        { path: 'docs/specs/runs.md', action: 'create', spec: { title: 'Runs' }, area: { specId: SPEC, title: 'Tasks and missions', proposed: false, by: 'domain' }, placement: { by: 'domain', reason: 'this team has no decision-model key' } },
      ],
    });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'import', attach_to: { 'docs/specs/claim-ordering.md': REL } }, ctx()));
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ workspaceId: WS, attachTo: { 'docs/specs/claim-ordering.md': REL } });
    expect(r.split('docs/specs/task-page.md').length - 1).toBe(1);
    expect(r).not.toContain('create: Task Page');
    expect(r).toContain('suggested: Decisions (d1) (p 0.80), below the filing bar, so it stays Unfiled');
    expect(r).toContain(`related: "Claim routing overview" (${REL}) cites this path`);
    expect(r).toContain(`attach_to: { "docs/specs/claim-ordering.md": "${REL}" }`);
    expect(r).toContain('Tasks and missions (by domain, classifier unavailable: this team has no decision-model key)');
  });

  it('confirm_import POSTs the batch and passes an agent run\'s 403 through; an OAuth session is told where to confirm', async () => {
    api.mockResolvedValueOnce({ confirmed: [{ specId: SPEC, title: 'Invoices', path: 'docs/specs/invoices.md', commitSha: 'b'.repeat(40) }], skipped: [{ specId: 'x2', path: 'docs/specs/moved.md', reason: 'stale', message: 'changed since bbbbbbb' }] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'confirm_import', specIds: [SPEC, 'x2'] }, ctx()));
    expect([api.mock.calls[0][0], JSON.parse(api.mock.calls[0][1].body)]).toEqual(['/api/specs/import/confirm', { specIds: [SPEC, 'x2'] }]);
    expect(r).toContain('Confirmed 1 import(s), 1 not confirmed');
    expect(r).toContain('docs/specs/moved.md: stale');

    api.mockResolvedValueOnce({ confirmed: [], skipped: [], pending: { confirmUrl: 'https://buildd.dev/app/workspaces/w/specs#imported', specIds: [SPEC] } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'confirm_import', specIds: [SPEC] }, ctx()))).toContain('Nothing was confirmed');

    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"an agent run cannot confirm"}'));
    const refused: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'confirm_import', specIds: [SPEC] }, ctx());
    expect([refused.isError, out(refused)]).toEqual([true, 'an agent run cannot confirm']);
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
  it('diff reads what changed between two revisions, with a read scope', async () => {
    expect(requiredScopeForAction('manage_specs', { action: 'diff' })).toBe('tasks:read');
    api.mockResolvedValueOnce({
      specId: SPEC, identical: false, omittedLines: 12,
      from: { revision: 1, contentHash: 'a', approved: true }, to: { revision: 3, contentHash: 'b', approved: false },
      sections: [{ kind: 'changed', path: 'Checkout > Rates', level: 2, linesAdded: 1, linesRemoved: 1 }],
      diff: '@@ Checkout > Rates (changed) @@\n-R-2: old\n+R-2: new',
    });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'diff', specId: SPEC, from: 1 }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/${SPEC}/diff?from=1`);
    expect(r).toContain('revision 1 (approved) → revision 3: 1 section(s) changed.');
    expect(r).toContain('changed Checkout > Rates (+1 −1)');
    expect(r).toContain('+R-2: new');
    expect(r).toContain('12 more diff line(s) not shown');

    api.mockResolvedValueOnce({ specId: SPEC, identical: true, omittedLines: 0, from: { revision: 2, approved: false }, to: { revision: 2, approved: false }, sections: [], diff: '' });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'diff', specId: SPEC }, ctx()))).toBe('revision 2 → revision 2: no change.');
    expect(api.mock.calls[1][0]).toBe(`/api/specs/${SPEC}/diff`);

    api.mockRejectedValueOnce(new Error('API error: 404 - {"error":"Spec has no revision 9"}'));
    const miss = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'diff', specId: SPEC, to: 9 }, ctx());
    expect([miss.isError, out(miss)]).toEqual([true, 'Spec has no revision 9']);
  });
});
