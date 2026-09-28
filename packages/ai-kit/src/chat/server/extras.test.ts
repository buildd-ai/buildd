import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { latestHandoffs } from '@builddai/ai-kit/chat/contract';
import {
  approvalRequestsIn, canonicalJson, createPermissionsApi, defineToolGroups, handoffEventMessage, handoffOf, handoffResult,
  hashToolInput, memoryChatStore, reconcileApprovals, ToolGroupsError,
} from './index';

const groups = defineToolGroups({
  notes: { label: 'Notes', modes: ['ask', 'allow'], tools: [{ name: 'create_note', class: 'write' }] },
  admin: { label: 'Admin', fixed: 'ask', tools: [{ name: 'delete_all', class: 'admin' }] },
  search: { label: 'Search', fixed: 'read', tools: [{ name: 'search', class: 'read' }] },
});

describe('hashToolInput', () => {
  it('is sha256 hex of canonical JSON (byte-identical to buildd\'s node:crypto version)', async () => {
    const input = { b: [1, { d: 2, c: undefined, a: 'x' }], a: null };
    expect(canonicalJson(input)).toBe('{"a":null,"b":[1,{"a":"x","d":2}]}');
    expect(await hashToolInput(input)).toBe(createHash('sha256').update(canonicalJson(input)).digest('hex'));
  });
});

describe('reconcileApprovals', () => {
  const stored = [{ type: 'tool-create_note', toolCallId: 'c1', state: 'approval-requested', input: { title: 'A' }, approval: { id: 'ap1' } }];
  const answer = (approved: boolean, input: unknown = { title: 'A' }) => [{ ...stored[0], input, state: 'approval-responded', approval: { id: 'ap1', approved } }];
  it('decides through the store and authorizes only a won approval', async () => {
    const store = memoryChatStore();
    await store.recordApprovals({ conversationId: 'c', messageId: 'm', userId: 'u', rows: await approvalRequestsIn(stored as never) });
    const decide = (a: { approvalId: string; inputHash: string; approved: boolean }) => store.decideApproval({ conversationId: 'c', userId: 'u', ...a });
    const r = await reconcileApprovals(stored as never, answer(true) as never, decide);
    expect(r.decided).toBe(1);
    expect([...r.authorizedToolCallIds]).toEqual(['c1']);
    expect((r.parts[0] as { state: string }).state).toBe('approval-responded');
    const replay = await reconcileApprovals(stored as never, answer(true) as never, decide);
    expect(replay.decided).toBe(0);
  });
  it('an edited input or another user decides nothing', async () => {
    const store = memoryChatStore();
    await store.recordApprovals({ conversationId: 'c', messageId: 'm', userId: 'u', rows: await approvalRequestsIn(stored as never) });
    expect((await reconcileApprovals(stored as never, answer(true, { title: 'B' }) as never, a => store.decideApproval({ conversationId: 'c', userId: 'u', ...a }))).decided).toBe(0);
    expect((await reconcileApprovals(stored as never, answer(true) as never, a => store.decideApproval({ conversationId: 'c', userId: 'someone-else', ...a }))).decided).toBe(0);
    expect(store.approvals[0].status).toBe('pending');
  });
});

describe('createPermissionsApi', () => {
  it('GET rows, PATCH toggles an allowable group, refuses locked ones', async () => {
    const prefs = new Map<string, unknown>([['u', ['notes', 'admin', 'bogus']]]);
    const api = createPermissionsApi(groups, { get: u => prefs.get(u), set: (u, g) => { prefs.set(u, g); } });
    expect([...await api.allowed('u')]).toEqual(['notes']);
    const got = await (await api.GET({ userId: 'u' })).json();
    expect(got.rows).toEqual([
      { key: 'notes', label: 'Notes', mode: 'allow', locked: false },
      { key: 'admin', label: 'Admin', mode: 'ask', locked: true },
      { key: 'search', label: 'Search', mode: 'read', locked: true },
    ]);
    const patch = (body: unknown) => api.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { userId: 'u' });
    expect((await patch({ group: 'notes', mode: 'ask' })).status).toBe(200);
    expect(prefs.get('u')).toEqual([]);
    expect((await patch({ group: 'admin', mode: 'allow' })).status).toBe(400);
    expect((await patch({ group: 'notes', mode: 'never' })).status).toBe(400);
  });
});

describe('hand-off helpers', () => {
  it('handoffResult is read back by handoffOf; event messages fold to the newest state', () => {
    const r = handoffResult({ taskId: 't1', url: 'https://x/t1', title: 'Plan' });
    expect(handoffOf(r)).toEqual({ taskId: 't1', url: 'https://x/t1', title: 'Plan' });
    expect(handoffOf({ data: 1 })).toBeNull();
    const done = handoffEventMessage({ id: 'e1', handoff: { taskId: 't1', url: 'https://x/t1', state: 'completed', title: 'Plan', summary: 'PR #3' } });
    expect(done.role).toBe('event');
    expect((done.parts[1] as unknown as { data: { text: string } }).data.text).toBe('Plan finished: PR #3');
    const filed = { id: 'a', role: 'assistant' as const, parts: [{ type: 'data-handoff', id: 't1', data: { taskId: 't1', url: 'https://x/t1', state: 'filed', title: 'Plan', toolCallId: 'c' } }] };
    expect(latestHandoffs([filed, done]).get('t1')).toMatchObject({ state: 'completed', title: 'Plan', toolCallId: 'c', summary: 'PR #3' });
  });
});

describe('labelOf', () => {
  it('names a group', () => {
    expect(groups.labelOf('notes')).toBe('Notes');
    expect(groups.labelOf('nope')).toBeUndefined();
    expect(() => defineToolGroups({ x: { label: 'X', fixed: 'read', tools: [{ name: 'w', class: 'write' }] } })).toThrow(ToolGroupsError);
  });
});
