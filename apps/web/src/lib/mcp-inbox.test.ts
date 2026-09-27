import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { withNotificationInbox, INBOX_SHOWN } = await import('./mcp-inbox');

const ACCOUNT = '99999999-9999-4999-8999-999999999999';
const TASK = '11111111-1111-4111-8111-111111111111';

type Row = { id: string; subscriptionId: string; eventType: string; payload: Record<string, unknown>; createdAt: string; lifetime: 'one_shot' | 'standing'; subjectRef: Record<string, unknown>; status: string };
const row = (id: string, minute: number, over: Partial<Row> = {}): Row => ({
  id, subscriptionId: `sub-${id}`, eventType: 'pr.merged', payload: { repo: 'acme/widgets', prNumber: minute },
  createdAt: `2026-09-27T12:${String(minute).padStart(2, '0')}:00.000Z`, lifetime: 'one_shot', subjectRef: {}, status: 'pending', ...over,
});

function ledger(rows: Row[]) {
  const ended = new Set<string>();
  const listUndelivered = mock(async (_owner: unknown) => rows.filter(r => r.status === 'pending' && !ended.has(r.subscriptionId)).map(r => ({ ...r })));
  const markDelivered = mock(async (_owner: unknown, id: string, _opts: { route: string }) => {
    const r = rows.find(x => x.id === id);
    if (!r || r.status !== 'pending' || ended.has(r.subscriptionId)) return { marked: false, subscriptionEnded: false };
    r.status = 'delivered';
    if (r.lifetime === 'one_shot') {
      ended.add(r.subscriptionId);
      for (const s of rows) if (s.subscriptionId === r.subscriptionId && s.status === 'pending') s.status = 'coalesced';
    }
    return { marked: true, subscriptionEnded: r.lifetime === 'one_shot' };
  });
  return { rows, deps: { listUndelivered, markDelivered } };
}

const result = (text = 'ok') => ({ content: [{ type: 'text' as const, text }] });

describe('withNotificationInbox: an MCP session sees its fired watches on its next buildd call', () => {
  it('appends pending notices to the tool result and marks them delivered via mcp, as the token\'s account', async () => {
    const l = ledger([row('d1', 5)]);
    const out = await withNotificationInbox(result('2 tasks'), { accountId: ACCOUNT }, l.deps as any);
    expect(out.content).toHaveLength(2);
    expect(out.content[0].text).toBe('2 tasks');
    expect(out.content[1].text).toContain('#5 merged.');
    expect(out.content[1].text).toContain('https://github.com/acme/widgets/pull/5');
    expect(l.deps.listUndelivered.mock.calls[0][0]).toEqual({ accountId: ACCOUNT });
    expect(l.deps.markDelivered.mock.calls.map(c => [c[0], c[1], c[2]])).toEqual([[{ accountId: ACCOUNT }, 'd1', { route: 'mcp' }]]);
  });

  it('the next call shows nothing again: each row is delivered once', async () => {
    const l = ledger([row('d1', 5)]);
    await withNotificationInbox(result(), { accountId: ACCOUNT }, l.deps as any);
    const again = await withNotificationInbox(result(), { accountId: ACCOUNT }, l.deps as any);
    expect(again.content).toHaveLength(1);
    expect(l.deps.markDelivered).toHaveBeenCalledTimes(1);
  });

  it(`at most ${3} per call, newest first, with a count of the rest left for the next call`, async () => {
    expect(INBOX_SHOWN).toBe(3);
    const l = ledger([row('a', 1), row('b', 2), row('c', 3), row('d', 4), row('e', 5)]);
    const out = await withNotificationInbox(result(), { accountId: ACCOUNT }, l.deps as any);
    const text = out.content[1].text;
    expect(text.indexOf('#5 merged.')).toBeLessThan(text.indexOf('#4 merged.'));
    expect(text).not.toContain('#2 merged.');
    expect(text).toContain('2 more');
    expect(l.rows.filter(r => r.status === 'delivered').map(r => r.id).sort()).toEqual(['c', 'd', 'e']);
    expect(l.rows.filter(r => r.status === 'pending').map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('a one-shot with two pending rows shows one; the claim coalesces the other', async () => {
    const l = ledger([
      row('first', 1, { subscriptionId: 's', eventType: 'task.failed', payload: { taskId: TASK, title: 'Build' } }),
      row('second', 2, { subscriptionId: 's', eventType: 'task.completed', payload: { taskId: TASK, title: 'Build' } }),
    ]);
    const out = await withNotificationInbox(result(), { accountId: ACCOUNT }, l.deps as any);
    expect(out.content[1].text).toContain('Build failed.');
    expect(out.content[1].text).not.toContain('Build is done.');
    expect(l.deps.markDelivered).toHaveBeenCalledTimes(1);
  });

  it('a row someone else already delivered is not shown', async () => {
    const l = ledger([row('d1', 5)]);
    l.deps.markDelivered.mockImplementation(async () => ({ marked: false, subscriptionEnded: false }));
    const out = await withNotificationInbox(result(), { accountId: ACCOUNT }, l.deps as any);
    expect(out.content).toHaveLength(1);
  });

  it('no account behind the token, or a ledger error: the result is returned untouched', async () => {
    const l = ledger([row('d1', 5)]);
    expect(await withNotificationInbox(result('x'), null, l.deps as any)).toEqual(result('x'));
    expect(l.deps.listUndelivered).not.toHaveBeenCalled();
    const broken = { listUndelivered: async () => { throw new Error('db'); }, markDelivered: async () => ({ marked: true }) };
    expect(await withNotificationInbox(result('x'), { accountId: ACCOUNT }, broken as any)).toEqual(result('x'));
  });
});
