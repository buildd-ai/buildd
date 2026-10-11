import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };
const A = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';

function recording(reply: Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const api: ApiFn = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply;
  };
  return { api, calls };
}
const run = async (api: ApiFn, action: string, params: Record<string, unknown>) => String((await handleBuilddAction(api, action, params, ctx)).content[0].text);

describe('link_artifact', () => {
  it('posts the link to the artifact links route and reports the pin', async () => {
    const { api, calls } = recording({ link: { id: 'L1', artifactId: A, subjectKind: 'task', subjectId: T, relation: 'normative_reference', artifactRevision: 3 } });
    const out = await run(api, 'link_artifact', { artifactId: A, subjectKind: 'task', subjectId: T, relation: 'normative_reference' });
    expect(calls).toEqual([{ path: `/api/artifacts/${A}/links`, method: 'POST', body: { subjectKind: 'task', subjectId: T, relation: 'normative_reference' } }]);
    expect(out).toContain('pinned to revision 3');
    expect(out).toContain('Link ID: L1');
  });

  it('unlinks by link id with unlink: true', async () => {
    const { api, calls } = recording({ ok: true });
    await run(api, 'link_artifact', { artifactId: A, linkId: 'L1', unlink: true });
    expect(calls).toEqual([{ path: `/api/artifacts/${A}/links?linkId=L1`, method: 'DELETE', body: undefined }]);
  });

  it('names the missing field', async () => {
    const { api } = recording({});
    await expect(run(api, 'link_artifact', { artifactId: A, subjectKind: 'task', relation: 'context' })).rejects.toThrow('subjectId is required');
    await expect(run(api, 'link_artifact', { artifactId: A, unlink: true })).rejects.toThrow('linkId is required');
  });
});

describe('list_artifact_links', () => {
  it('lists what is linked to a subject as a manifest, without bodies', async () => {
    const { api, calls } = recording({ artifacts: [{ linkId: 'L1', artifactId: A, relation: 'context', title: 'Design', type: 'file', pinnedRevision: null, currentRevision: 2, sizeBytes: 4096, contentHash: 'abc' }] });
    const out = await run(api, 'list_artifact_links', { subjectKind: 'mission', subjectId: T, relation: 'context' });
    expect(calls[0].path).toBe(`/api/artifacts/linked?subjectKind=mission&subjectId=${T}&relation=context`);
    expect(out).toContain('Design — context, file, 4096 bytes, rev 2, sha256 abc');
  });

  it('lists an artifact\'s own links', async () => {
    const { api, calls } = recording({ links: [{ id: 'L1', relation: 'evidence', subjectKind: 'task', subjectId: T, artifactRevision: null }] });
    const out = await run(api, 'list_artifact_links', { artifactId: A });
    expect(calls[0].path).toBe(`/api/artifacts/${A}/links`);
    expect(out).toContain(`evidence → task ${T}`);
  });

  it('needs an artifact or a subject', async () => {
    const { api } = recording({});
    await expect(run(api, 'list_artifact_links', {})).rejects.toThrow('Pass artifactId, or subjectKind + subjectId');
  });
});
