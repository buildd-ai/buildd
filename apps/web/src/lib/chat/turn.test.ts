import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

/**
 * The P1 acceptance properties, through the real AI SDK v7 loop with a mock
 * model: capability off / no key ⇒ no turn; one approval card; confirming files
 * exactly one mission; denying files nothing; replaying the approval files
 * nothing. Storage is in memory; the atomic approval decision is simulated with
 * the same compare-and-set semantics as the UPDATE … WHERE status='pending'.
 */

// ── in-memory storage ─────────────────────────────────────────────────────────
type Row = { id: string; conversationId: string; role: string; parts: any[]; tier?: string | null; model?: string | null; usage?: any; authorUserId?: string | null; createdAt: Date };
let messages: Row[] = [];
let approvals: Array<{ approvalId: string; toolCallId: string; inputHash: string; status: string; result?: unknown }> = [];
let seq = 0;

mock.module('./store', () => ({
  HISTORY_LIMIT: 40,
  loadMessages: async (cid: string) => messages.filter(m => m.conversationId === cid),
  insertMessage: async (m: any) => {
    const row = { id: m.id ?? `msg-${++seq}`, createdAt: new Date(), ...m };
    messages.push(row);
    return row;
  },
  updateMessage: async (id: string, _cid: string, patch: any) => {
    const row = messages.find(m => m.id === id)!;
    Object.assign(row, { parts: patch.parts }, patch.usage !== undefined ? { usage: patch.usage } : {});
  },
  pingConversation: async () => {},
}));

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({
      values: (rows: any[]) => ({
        onConflictDoNothing: async () => {
          for (const r of rows) if (!approvals.some(a => a.approvalId === r.approvalId)) approvals.push({ ...r, status: 'pending' });
        },
      }),
    }),
    update: () => ({ set: (s: any) => ({ where: async () => { if ('result' in s) { const a = approvals.find(x => x.status === 'approved'); if (a) a.result = s.result; } } }) }),
  },
}));

const { runChatTurn } = await import('./turn');
const { hashToolInput } = await import('./approvals');

// ── helpers ───────────────────────────────────────────────────────────────────
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });
const textStream = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' },
    finish('stop'),
  ]),
});
const toolStream = (toolCallId: string, toolName: string, input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    finish('tool-calls'),
  ]),
});

const MISSION_INPUT = {
  action: 'create', title: 'Bill in local currency',
  description: 'Charge customers in their own currency.', goalCriteria: [{ type: 'all_prs_merged' }],
};

const conversation = {
  id: 'conv-1', teamId: 'team-1', workspaceId: 'ws-1', createdByUserId: 'u-1', title: null,
  titleSource: 'auto', agentRoleSlug: 'organizer', lastMessageAt: new Date(), archivedAt: null, createdAt: new Date(),
} as any;
const user = { id: 'u-1', name: 'Sam', timeZone: 'Pacific/Auckland', teamRole: 'member' as const };

function harness(opts: { enabled?: boolean; key?: boolean; model?: MockLanguageModelV4; limits?: () => Promise<any>; route?: () => Promise<any> }) {
  const apiCalls: string[] = [];
  const linked: string[] = [];
  const decide = async ({ approvalId, inputHash, approved }: any) => {
    const a = approvals.find(x => x.approvalId === approvalId);
    if (!a || a.status !== 'pending' || a.inputHash !== inputHash) return false;
    a.status = approved ? 'approved' : 'denied';
    return true;
  };
  const deps = {
    now: () => new Date('2026-09-26T21:30:00Z'),
    chatEnabled: async () => opts.enabled ?? true,
    limits: opts.limits ?? (async () => ({ ok: true as const, budgetWarning: false })),
    route: opts.route ?? (async () => ({ tier: 'standard' as const, allowWrites: true, source: 'fallback' as const })),
    resolveModel: async (o: any) => (opts.key ?? true)
      ? { ok: true as const, model: opts.model!, provider: 'openrouter' as const, modelId: 'test-model', tier: o.tier, keyScope: 'team' as const }
      : { ok: false as const, reason: 'no_key' as const, provider: 'anthropic', tier: o.tier },
    makeApi: (onCall: any) => async (endpoint: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      apiCalls.push(`${method} ${endpoint.split('?')[0]}`);
      const path = endpoint.split('?')[0];
      const body = method === 'POST' && path === '/api/missions'
        ? { id: 'mission-1', title: 'Bill in local currency', status: 'active', workspaceId: 'ws-1' }
        : { tasks: [{ id: 'task-1', title: 'Currency table', status: 'in_progress', workspaceId: 'ws-1' }] };
      onCall({ method, path, status: 200, body });
      return body;
    },
    actionContext: { workspaceId: 'ws-1', teamId: 'team-1', getWorkspaceId: async () => 'ws-1', getLevel: async () => 'admin' } as any,
    decide,
    linkMission: async (id: string) => { linked.push(id); },
  };
  const turn = async (message: any) => {
    const res = await runChatTurn({ conversation, workspace: { id: 'ws-1', name: 'billing-web' }, user, body: { message }, deps });
    const text = res.body ? await res.text() : '';
    await new Promise(r => setTimeout(r, 20)); // let onEnd persistence settle
    return { res, text };
  };
  return { turn, apiCalls, linked };
}

const userMsg = (text: string) => ({ id: 'client-1', role: 'user', parts: [{ type: 'text', text }] });
const lastAssistant = () => messages.filter(m => m.role === 'assistant').at(-1)!;
function answer(approved: boolean, tamper?: Record<string, unknown>) {
  const a = lastAssistant();
  return {
    id: a.id, role: 'assistant',
    parts: a.parts.map(p => p.state === 'approval-requested'
      ? { ...p, ...(tamper ? { input: { ...p.input, ...tamper } } : {}), state: 'approval-responded', approval: { ...p.approval, approved } }
      : p),
  };
}

beforeEach(() => { messages = []; approvals = []; seq = 0; });

describe('nothing changes without the capability or a key', () => {
  it('capability off ⇒ 403 before any model call or write', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('hi') as any });
    const { turn } = harness({ enabled: false, model });
    const { res, text } = await turn(userMsg('what is in flight?'));
    expect(res.status).toBe(403);
    expect(JSON.parse(text).error).toBe('capability_disabled');
    expect(model.doStreamCalls).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it('no key ⇒ 409 no_key, no model call, nothing saved (the UI falls back to the mission form)', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('hi') as any });
    const { turn } = harness({ key: false, model });
    const { res, text } = await turn(userMsg('what is in flight?'));
    expect(res.status).toBe(409);
    expect(JSON.parse(text).error).toBe('no_key');
    expect(model.doStreamCalls).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });
});

describe('a read-only question', () => {
  it('streams, runs the read tool straight away, and saves tool parts with object refs', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStream('call-r', 'list_tasks', {}), textStream('One task is in flight.')] as any,
    });
    const { turn, apiCalls } = harness({ model });
    const { res } = await turn(userMsg("what's in flight on billing-web?"));
    expect(res.status).toBe(200);
    expect(apiCalls).toEqual(['GET /api/tasks']);
    const saved = lastAssistant();
    const toolPart = saved.parts.find(p => p.type === 'tool-list_tasks');
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.output.objects[0]).toMatchObject({ kind: 'task', id: 'task-1' });
    expect(saved.parts.some(p => p.type === 'text' && p.text.includes('One task'))).toBe(true);
    expect(saved.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('the context block carries the user\'s local date and zone', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('ok') as any });
    const { turn } = harness({ model });
    await turn(userMsg('hello'));
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(prompt).toContain('2026-09-27T10:30:00+13:00');
    expect(prompt).toContain('Pacific/Auckland');
    expect(prompt).toContain('conv-1');
  });
});

describe('"make this a mission"', () => {
  function modelForMission() {
    return new MockLanguageModelV4({
      doStream: [toolStream('call-m', 'manage_missions', MISSION_INPUT), textStream('Filed it.')] as any,
    });
  }

  it('produces exactly one approval card and files nothing yet', async () => {
    const { turn, apiCalls } = harness({ model: modelForMission() });
    await turn(userMsg('make this a mission'));
    const cards = lastAssistant().parts.filter(p => p.state === 'approval-requested');
    expect(cards).toHaveLength(1);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolCallId: 'call-m', status: 'pending', inputHash: hashToolInput(MISSION_INPUT) });
    expect(apiCalls).toEqual([]);
  });

  it('a second write in the same turn is denied, so there is still one card', async () => {
    const model = new MockLanguageModelV4({
      doStream: [{
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'manage_missions', input: JSON.stringify(MISSION_INPUT) },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'manage_missions', input: JSON.stringify({ ...MISSION_INPUT, title: 'Another' }) },
          finish('tool-calls'),
        ]),
      }, textStream('One at a time.')] as any,
    });
    const { turn, apiCalls } = harness({ model });
    await turn(userMsg('file two missions'));
    expect(lastAssistant().parts.filter(p => p.state === 'approval-requested')).toHaveLength(1);
    expect(apiCalls).toEqual([]);
  });

  it('confirming files exactly one mission, links it to the conversation, and replay files nothing', async () => {
    const model = modelForMission();
    const { turn, apiCalls, linked } = harness({ model });
    await turn(userMsg('make this a mission'));

    const confirm = answer(true);
    const first = await turn(confirm);
    expect(first.res.status).toBe(200);
    expect(apiCalls).toEqual(['POST /api/missions']);
    expect(linked).toEqual(['mission-1']);
    const part = lastAssistant().parts.find(p => p.type === 'tool-manage_missions');
    expect(part.state).toBe('output-available');
    expect(part.output.objects).toEqual([expect.objectContaining({ kind: 'mission', id: 'mission-1' })]);

    const replay = await turn(confirm);
    expect(replay.res.status).toBe(409);
    expect(apiCalls).toEqual(['POST /api/missions']);
  });

  it('denying files nothing', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStream('call-m', 'manage_missions', MISSION_INPUT), textStream('Okay, not filed.')] as any,
    });
    const { turn, apiCalls, linked } = harness({ model });
    await turn(userMsg('make this a mission'));
    const r = await turn(answer(false));
    expect(r.res.status).toBe(200);
    expect(apiCalls).toEqual([]);
    expect(linked).toEqual([]);
    expect(approvals[0].status).toBe('denied');
    expect(lastAssistant().parts.find(p => p.type === 'tool-manage_missions').state).toBe('output-denied');
  });

  it('an edited approval (different input) decides and files nothing', async () => {
    const { turn, apiCalls } = harness({ model: modelForMission() });
    await turn(userMsg('make this a mission'));
    const r = await turn(answer(true, { title: 'Something else' }));
    expect(r.res.status).toBe(409);
    expect(apiCalls).toEqual([]);
    expect(approvals[0].status).toBe('pending');
  });
});

describe('limits', () => {
  it('a refused turn returns the limit message and retry-after, and never routes, calls a model or saves', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('hi') as any });
    let routed = 0;
    const { turn } = harness({
      model,
      limits: async () => ({ ok: false, reason: 'budget_exhausted', scope: 'user', retryAfterSeconds: 3600, message: 'You\'ve used your daily chat limit.' }),
      route: async () => { routed++; return { tier: 'standard', allowWrites: true, source: 'fallback' }; },
    });
    const { res, text } = await turn(userMsg('what is in flight?'));
    expect(res.status).toBe(429);
    expect(JSON.parse(text)).toMatchObject({ error: 'budget_exhausted', scope: 'user', retryAfterSeconds: 3600, message: 'You\'ve used your daily chat limit.' });
    expect(routed).toBe(0);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it('approval answers go through the same limits', async () => {
    let checks = 0;
    const model = new MockLanguageModelV4({
      doStream: [toolStream('call-m', 'manage_missions', MISSION_INPUT), textStream('Filed it.')] as any,
    });
    const { turn, apiCalls } = harness({
      model,
      limits: async () => (++checks === 1
        ? { ok: true, budgetWarning: false }
        : { ok: false, reason: 'rate_limited', retryAfterSeconds: 60, message: 'Try again in 1 minute.' }),
    });
    await turn(userMsg('make this a mission'));
    const r = await turn(answer(true));
    expect(r.res.status).toBe(429);
    expect(apiCalls).toEqual([]);
    expect(approvals[0].status).toBe('pending');
  });

  it('the routing decision call\'s cost is recorded with the turn, so it counts toward the budget', async () => {
    const model = new MockLanguageModelV4({ doStream: textStream('ok') as any });
    const { turn } = harness({
      model,
      route: async () => ({ tier: 'standard', allowWrites: true, source: 'decision', usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.0007 } }),
    });
    await turn(userMsg('hello'));
    const saved = messages.find(m => m.role === 'user')!;
    expect(saved.usage).toEqual({ inputTokens: 40, outputTokens: 4, costUsd: 0.0007 });
  });
});
