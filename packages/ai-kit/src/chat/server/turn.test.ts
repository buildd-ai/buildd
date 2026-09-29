/**
 * `createChatTurn` through the real AI SDK v7 loop with a mock model and the
 * in-memory store: refusals before spend, approval gating (one card per turn,
 * confirm runs once, replay/edit/deny run nothing), Allow under the taint rule,
 * hand-off, thinking steps, abort, usage receipts, and steering.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { APICallError, tool } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import {
  createChatTurn,
  defineToolGroups,
  handoffResult,
  hashToolInput,
  memoryChatStore,
  memorySteerQueue,
  modelFromPlan,
  ONE_CARD_PER_TURN_REASON,
  STOPPED_NOTE,
  ToolGroupsError,
  type PreviewOutcome,
  type TurnUsageRecord,
} from './index';
import type { UsageReceipt } from '@builddai/ai-kit/models';
import { PlanDeniedError } from '@builddai/ai-kit/models';

// ── Mock model streams ────────────────────────────────────────────────────────
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });
const textStream = (text: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' },
    finish('stop'),
  ]),
});
const toolStream = (...calls: Array<[id: string, name: string, input: unknown]>) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    ...calls.map(([toolCallId, toolName, input]) => ({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) })),
    finish('tool-calls'),
  ]),
});
const mockModel = (...responses: unknown[]) => new MockLanguageModelV4({ doStream: responses as any });

// ── A small app ───────────────────────────────────────────────────────────────
const groups = defineToolGroups({
  notes: {
    label: 'Notes',
    modes: ['ask', 'allow'],
    tools: [
      { name: 'search_notes', class: 'read', steps: { active: 'Searching your notes', done: 'Searched your notes' } },
      { name: 'create_note', class: 'write' },
    ],
  },
  jobs: { label: 'Hand-off', fixed: 'ask', tools: [{ name: 'hand_off', class: 'write', spends: true }] },
  keys: { label: 'Keys', fixed: 'never' },
});

let notes: Array<{ id: string; title: string }>;
let filed: string[];
let store: ReturnType<typeof memoryChatStore>;
let receipts: UsageReceipt[];
let ledger: TurnUsageRecord[];

const tools = {
  search_notes: tool({
    description: 'Search notes',
    inputSchema: z.object({ q: z.string().optional() }),
    execute: async () => ({ data: notes, objects: [], summary: `${notes.length} notes` }),
  }),
  create_note: tool({
    description: 'Create a note',
    inputSchema: z.object({ title: z.string() }),
    execute: async ({ title }: { title: string }) => {
      notes.push({ id: `n${notes.length + 1}`, title });
      return { data: 'created', objects: [], summary: 'created' };
    },
  }),
  hand_off: tool({
    description: 'File a long task',
    inputSchema: z.object({ brief: z.string() }),
    execute: async ({ brief }: { brief: string }) => {
      filed.push(brief);
      return handoffResult({ taskId: 'task-9', url: 'https://buildd.dev/tasks/task-9', title: brief });
    },
  }),
};

const preview = (tool: string, input: Record<string, unknown>): PreviewOutcome => {
  if (input.title === '??') return { ok: false, question: 'Which note do you mean?' };
  return {
    ok: true,
    preview: {
      v: 1, verb: tool === 'hand_off' ? 'File a task' : 'Create note',
      target: { kind: 'note', id: 'new', label: String(input.title ?? input.brief) },
      changes: [{ label: 'Title', before: null, after: String(input.title ?? input.brief) }],
      fingerprint: `fp-${notes.length}`,
    },
  };
};

const plan = { planId: 'plan-1', planSource: 'registry', requestedTier: 'standard', tier: 'standard', surface: 'chat', kind: 'chat_turn', provider: 'openrouter', model: 'vendor/model-x', effort: null, limits: { maxTurns: null }, price: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }, budget: null, expiresAt: new Date(0).toISOString() } as const;

function harness(o: { model: MockLanguageModelV4; key?: string | null; allow?: string[]; deny?: boolean; steering?: ReturnType<typeof memorySteerQueue>; turnMs?: number; tools?: Record<string, unknown>; limits?: Record<string, number>; title?: unknown }) {
  const planned: unknown[] = [];
  const models = {
    plan: async (req: unknown) => { planned.push(req); if (o.deny) throw new PlanDeniedError({ ...plan, budget: { action: 'deny', reason: 'daily_cap_reached' } } as never); return plan as any; },
    recordUsage: (r: UsageReceipt) => { receipts.push(r); },
  };
  const created: unknown[] = [];
  const turn = createChatTurn({
    toolGroups: groups,
    tools: (o.tools ?? tools) as any,
    model: modelFromPlan({
      models: models as any,
      key: () => (o.key === undefined ? 'sk-or-test' : o.key),
      create: ({ config }) => { created.push(config); return o.model; },
      appName: 'kit-test',
    }),
    system: 'You are a test assistant.',
    store,
    permissions: () => o.allow ?? [],
    preview: (t, i) => preview(t, i),
    onUsage: r => { ledger.push(r); },
    ...(o.steering ? { steering: { queue: o.steering } } : {}),
    ...(o.title ? { title: o.title as any } : {}),
    ...(o.turnMs || o.limits ? { limits: { ...(o.turnMs ? { turnMs: o.turnMs } : {}), ...o.limits } } : {}),
  });
  const send = async (message: unknown, signal?: AbortSignal) => {
    const res = await turn.run({ body: { message }, userId: 'u-1', conversationId: 'c-1', ...(signal ? { signal } : {}) });
    const text = res.body ? await res.text() : '';
    await new Promise(r => setTimeout(r, 20)); // let onEnd persistence settle
    return { res, text };
  };
  return { turn, send, planned, created };
}

const userMsg = (text: string) => ({ id: 'client-1', role: 'user', parts: [{ type: 'text', text }] });
const saved = () => store.messages.get('c-1') ?? [];
const lastAssistant = () => saved().filter(m => m.role === 'assistant').at(-1)!;
const partsOf = (type: string) => lastAssistant().parts.filter((p: any) => p.type === type) as any[];
function answer(approved: boolean, tamper?: Record<string, unknown>) {
  const a = lastAssistant();
  return {
    id: a.id, role: 'assistant',
    parts: a.parts.map((p: any) => p.state === 'approval-requested'
      ? { ...p, ...(tamper ? { input: { ...p.input, ...tamper } } : {}), state: 'approval-responded', approval: { ...p.approval, approved } }
      : p),
  };
}
const sse = (text: string) => text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));

beforeEach(() => {
  notes = [{ id: 'n1', title: 'Groceries' }];
  filed = [];
  store = memoryChatStore();
  receipts = [];
  ledger = [];
});

describe('refused before any spend', () => {
  it('no key ⇒ 409 no_key, no model call, nothing saved', async () => {
    const model = mockModel(textStream('hi'));
    const { send } = harness({ model, key: null });
    const { res, text } = await send(userMsg('hello'));
    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ error: 'no_key', provider: 'openrouter' });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(saved()).toHaveLength(0);
  });

  it('a denied plan ⇒ 429 budget_exhausted', async () => {
    const model = mockModel(textStream('hi'));
    const { send } = harness({ model, deny: true });
    const { res, text } = await send(userMsg('hello'));
    expect(res.status).toBe(429);
    expect(JSON.parse(text).error).toBe('budget_exhausted');
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('bad bodies are 400', async () => {
    const { send } = harness({ model: mockModel(textStream('x')) });
    expect((await send({ role: 'user', parts: [] })).res.status).toBe(400);
    expect((await send(userMsg('   '))).res.status).toBe(400);
  });
});

describe('the model comes from the plan', () => {
  it('asks for a chat plan, builds the model from toCallConfig with the key, and stamps tier/model on the message', async () => {
    const { send, planned, created } = harness({ model: mockModel(textStream('Hello.')) });
    const { res, text } = await send(userMsg('hello'));
    expect(res.status).toBe(200);
    expect(planned).toEqual([{ tier: 'standard', kind: 'chat_turn', surface: 'chat' }]);
    expect(created[0]).toMatchObject({ provider: 'openrouter', model: 'vendor/model-x', apiKey: 'sk-or-test', headers: { 'X-Title': 'kit-test' } });
    expect(sse(text).find(c => c.type === 'start').messageMetadata).toMatchObject({ tier: 'standard', model: 'vendor/model-x', planSource: 'registry' });
    expect(lastAssistant()).toMatchObject({ tier: 'standard', model: 'vendor/model-x' });
    expect(saved().map(m => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('usage', () => {
  it('sends one content-free receipt and awaits the app ledger record', async () => {
    const { send } = harness({ model: mockModel(toolStream(['r1', 'search_notes', {}]), textStream('One note.')) });
    await send(userMsg('what notes?'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      plan: { planId: 'plan-1', planSource: 'registry', model: 'vendor/model-x', provider: 'openrouter', tier: 'standard' },
      kind: 'chat', tokens: { input: 20, output: 10 }, outcome: 'ok',
    });
    expect(Object.keys(receipts[0]).sort()).toEqual(['kind', 'latencyMs', 'outcome', 'plan', 'tokens']);
    expect(JSON.stringify(receipts[0])).not.toContain('u-1');
    expect(ledger).toHaveLength(1);
    // Estimated from the plan's list price: 20 × $1 + 10 × $2 per 1M tokens.
    expect(ledger[0]).toMatchObject({ userId: 'u-1', conversationId: 'c-1', inputTokens: 20, outputTokens: 10, costUsd: 0.00004, outcome: 'ok', continuation: false });
    expect(lastAssistant().usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('continuation sums prior cost with new turn cost', async () => {
    const { send } = harness({
      model: mockModel(toolStream(['w1', 'create_note', { title: 'Note 1' }]), textStream('Card.'), textStream('Done.')),
    });
    await send(userMsg('add a note'));
    const firstCost = ledger[0].costUsd ?? 0;
    const confirm = answer(true);
    await send(confirm);
    expect(ledger).toHaveLength(2);
    const firstTurn = ledger[0];
    const continuation = ledger[1];
    expect(firstTurn.continuation).toBe(false);
    expect(continuation.continuation).toBe(true);
    expect(lastAssistant().usage?.costUsd).toBe(firstCost + (continuation.costUsd ?? 0));
  });
});

describe('reads and thinking steps', () => {
  it('a read runs straight away and the checklist shows it active then done, in plain words', async () => {
    const { send } = harness({ model: mockModel(toolStream(['r1', 'search_notes', {}]), textStream('One note.')) });
    const { text } = await send(userMsg('what notes?'));
    const steps = sse(text).filter(c => c.type === 'data-step');
    expect(steps.map(s => [s.id, s.data.state, s.data.label])).toEqual([
      ['r1', 'active', 'Searching your notes'],
      ['r1', 'done', 'Searched your notes'],
    ]);
    // One step part per call in the saved message (updated in place by id).
    expect(partsOf('data-step')).toHaveLength(1);
    expect(partsOf('tool-search_notes')[0].state).toBe('output-available');
  });

  it('a tool factory can add its own steps, which land after the message starts', async () => {
    const model = mockModel(textStream('ok'));
    const turn = createChatTurn({
      toolGroups: groups, store, system: 's',
      model: async () => ({ ok: true, model, plan: plan as any }),
      tools: (ctx) => { ctx.step('Reading your calendar', 'done', 'cal'); return {}; },
    });
    const res = await turn.run({ body: { message: userMsg('hi') }, userId: 'u-1', conversationId: 'c-1' });
    const chunks = sse(await res.text());
    const start = chunks.findIndex(c => c.type === 'start');
    const step = chunks.findIndex(c => c.type === 'data-step');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(step).toBeGreaterThan(start);
    expect(chunks[step].data).toEqual({ id: 'cal', label: 'Reading your calendar', state: 'done' });
  });
});

describe('approval cards', () => {
  it('a write shows exactly one card with the server-built preview, runs nothing, and records a pending approval', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: 'Call mum' }]), textStream('Needs your OK.')) });
    const { text } = await send(userMsg('add a note'));
    const cards = partsOf('tool-create_note').filter(p => p.state === 'approval-requested');
    expect(cards).toHaveLength(1);
    expect(cards[0].approval.requestReason).toContain('buildd-preview:');
    expect(notes).toHaveLength(1);
    expect(store.approvals).toEqual([expect.objectContaining({ toolCallId: 'w1', status: 'pending', userId: 'u-1', inputHash: await hashToolInput({ title: 'Call mum' }) })]);
    expect(sse(text).filter(c => c.type === 'data-step').at(-1).data).toMatchObject({ id: 'w1', label: 'Check it with you', state: 'pending' });
  });

  it('a second write in the same turn is denied: still one card', async () => {
    const { send } = harness({
      model: mockModel(toolStream(['w1', 'create_note', { title: 'A' }], ['w2', 'create_note', { title: 'B' }]), textStream('One at a time.')),
    });
    await send(userMsg('add two notes'));
    const parts = partsOf('tool-create_note');
    expect(parts.filter(p => p.state === 'approval-requested')).toHaveLength(1);
    const denied = parts.find(p => p.toolCallId === 'w2');
    expect(denied.state).toBe('output-denied');
    expect(JSON.stringify(denied)).toContain(ONE_CARD_PER_TURN_REASON);
    expect(notes).toHaveLength(1);
  });

  it('confirming runs the write exactly once; replaying the approval runs nothing', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: 'Call mum' }]), textStream('Card.'), textStream('Done.')) });
    await send(userMsg('add a note'));
    const confirm = answer(true);
    const first = await send(confirm);
    expect(first.res.status).toBe(200);
    expect(notes.map(n => n.title)).toEqual(['Groceries', 'Call mum']);
    expect(partsOf('tool-create_note')[0].state).toBe('output-available');
    expect(store.approvals[0].status).toBe('approved');
    expect(store.approvals[0].result).toMatchObject({ data: 'created' });
    // The continuation updates the same assistant message; its usage is summed.
    expect(saved().filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(lastAssistant().usage!.inputTokens).toBe(20);
    expect(ledger.map(l => l.continuation)).toEqual([false, true]);

    const replay = await send(confirm);
    expect(replay.res.status).toBe(409);
    expect(notes).toHaveLength(2);
  });

  it('denying runs nothing', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: 'X' }]), textStream('Card.'), textStream('Okay.')) });
    await send(userMsg('add a note'));
    const r = await send(answer(false));
    expect(r.res.status).toBe(200);
    expect(notes).toHaveLength(1);
    expect(store.approvals[0].status).toBe('denied');
    expect(partsOf('tool-create_note')[0].state).toBe('output-denied');
  });

  it('an edited approval (different input) decides and runs nothing', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: 'X' }]), textStream('Card.')) });
    await send(userMsg('add a note'));
    const r = await send(answer(true, { title: 'Something else' }));
    expect(r.res.status).toBe(409);
    expect(notes).toHaveLength(1);
    expect(store.approvals[0].status).toBe('pending');
  });

  it('a target that changed since the card was shown runs nothing', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: 'X' }]), textStream('Card.'), textStream('It changed.')) });
    await send(userMsg('add a note'));
    notes.push({ id: 'n2', title: 'someone else wrote this' }); // the preview fingerprint moves
    await send(answer(true));
    expect(notes.map(n => n.title)).not.toContain('X');
    expect(JSON.stringify(partsOf('tool-create_note')[0].output)).toContain('changed since the card was shown');
  });

  it('an unclear target gets no card: the tool answers with the question', async () => {
    const { send } = harness({ model: mockModel(toolStream(['w1', 'create_note', { title: '??' }]), textStream('Which one?')) });
    await send(userMsg('rename it'));
    const part = partsOf('tool-create_note')[0];
    expect(part.state).toBe('output-available');
    expect(part.output.data).toBe('Needs clarification: Which note do you mean?');
    expect(store.approvals).toHaveLength(0);
    expect(notes).toHaveLength(1);
  });
});

describe('Allow (canSkipCard, server-enforced)', () => {
  it('an Allowed write proposed before any tool ran skips its card and is marked allowed', async () => {
    const { send } = harness({ allow: ['notes'], model: mockModel(toolStream(['w1', 'create_note', { title: 'Quick' }]), textStream('Added.')) });
    await send(userMsg('add a note'));
    const part = partsOf('tool-create_note')[0];
    expect(part.state).toBe('output-available');
    expect(part.output.allowed).toBe(true);
    expect(store.approvals).toHaveLength(0);
    expect(notes.map(n => n.title)).toContain('Quick');
  });

  it('the same write after a read tool ran in the turn still shows a card (taint)', async () => {
    const { send } = harness({
      allow: ['notes'],
      model: mockModel(toolStream(['r1', 'search_notes', {}]), toolStream(['w1', 'create_note', { title: 'Quick' }]), textStream('Card.')),
    });
    await send(userMsg('look, then add'));
    expect(partsOf('tool-create_note')[0].state).toBe('approval-requested');
    expect(notes).toHaveLength(1);
  });

  it('tool output anywhere in the stored conversation taints later turns', async () => {
    const { send } = harness({
      allow: ['notes'],
      model: mockModel(toolStream(['r1', 'search_notes', {}]), textStream('One note.'), toolStream(['w1', 'create_note', { title: 'Quick' }]), textStream('Card.')),
    });
    await send(userMsg('what notes?'));
    await send(userMsg('add one'));
    expect(partsOf('tool-create_note')[0].state).toBe('approval-requested');
  });

  it('only the first Allowed write of a turn skips; the second gets the card', async () => {
    const { send } = harness({
      allow: ['notes'],
      model: mockModel(toolStream(['w1', 'create_note', { title: 'A' }], ['w2', 'create_note', { title: 'B' }]), textStream('ok')),
    });
    await send(userMsg('two notes'));
    const parts = partsOf('tool-create_note');
    expect(parts.find(p => p.toolCallId === 'w1').state).toBe('output-available');
    expect(parts.find(p => p.toolCallId === 'w2').state).toBe('approval-requested');
  });

  it('a group not set to Allow asks', async () => {
    const { send } = harness({ allow: [], model: mockModel(toolStream(['w1', 'create_note', { title: 'A' }]), textStream('Card.')) });
    await send(userMsg('add'));
    expect(partsOf('tool-create_note')[0].state).toBe('approval-requested');
  });
});

describe('tool registration', () => {
  it('a tool not declared in any group fails closed, before anything is saved', async () => {
    const { send } = harness({
      model: mockModel(textStream('x')),
      tools: { ...tools, rogue: tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'x' }) },
    });
    await expect(send(userMsg('hi'))).rejects.toBeInstanceOf(ToolGroupsError);
    expect(saved()).toHaveLength(0); // refused before anything was written
  });

  it('a never group contributes no tool the model can see', async () => {
    const model = mockModel(textStream('ok'));
    const { send } = harness({ model });
    await send(userMsg('hi'));
    const offered = (model.doStreamCalls[0].tools ?? []).map((t: any) => t.name).sort();
    expect(offered).toEqual(['create_note', 'hand_off', 'search_notes']);
  });
});

describe('hand-off', () => {
  it('always asks (spends, even under Allow); approving files one task and streams a data-handoff part', async () => {
    const { send } = harness({
      allow: ['notes'],
      model: mockModel(toolStream(['h1', 'hand_off', { brief: 'Plan the trip' }]), textStream('Card.'), textStream('Filed.')),
    });
    await send(userMsg('plan the trip for me'));
    expect(partsOf('tool-hand_off')[0].state).toBe('approval-requested');
    expect(filed).toEqual([]);

    const { text } = await send(answer(true));
    expect(filed).toEqual(['Plan the trip']);
    const handoff = sse(text).find(c => c.type === 'data-handoff');
    expect(handoff).toMatchObject({ id: 'task-9', data: { taskId: 'task-9', url: 'https://buildd.dev/tasks/task-9', state: 'filed', toolCallId: 'h1', title: 'Plan the trip' } });
    expect(sse(text).filter(c => c.type === 'data-step').at(-1).data).toEqual({ id: 'h1', label: 'Filed as a task', state: 'done' });
    expect(partsOf('data-handoff')).toHaveLength(1);
    expect(store.handoffs).toEqual([{ conversationId: 'c-1', messageId: lastAssistant().id, toolCallId: 'h1', taskId: 'task-9', url: 'https://buildd.dev/tasks/task-9' }]);
  });
});

describe('stop and abort', () => {
  it('an aborted turn saves what streamed plus the stopped note, and reports outcome aborted', async () => {
    const ac = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }: any) => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't' });
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Partial' });
            abortSignal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            setTimeout(() => ac.abort(), 10);
          },
        }),
      }),
    } as any);
    const { send } = harness({ model });
    const { res } = await send(userMsg('write a long answer'), ac.signal);
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 30));
    const texts = partsOf('text').map(p => p.text);
    expect(texts).toContain(STOPPED_NOTE);
    expect(receipts.at(-1)?.outcome).toBe('aborted');
    expect(ledger.at(-1)?.outcome).toBe('aborted');
  });
});

describe('steering (behind a flag)', () => {
  it('is off unless configured', async () => {
    const { turn } = harness({ model: mockModel(textStream('x')) });
    expect((await turn.steer({ conversationId: 'c-1', userId: 'u-1', text: 'hi' })).status).toBe(404);
  });

  it('a steer queued mid-turn is injected at the next step boundary', async () => {
    const queue = memorySteerQueue();
    let turnRef: ReturnType<typeof harness>['turn'];
    const readTool = tool({
      description: 'Search notes',
      inputSchema: z.object({ q: z.string().optional() }),
      execute: async () => {
        await turnRef.steer({ conversationId: 'c-1', userId: 'u-1', text: 'only the work ones', id: 's1' });
        return { data: notes, objects: [] };
      },
    });
    const model = mockModel(toolStream(['r1', 'search_notes', {}]), textStream('Work notes only.'));
    const h = harness({ model, steering: queue, tools: { ...tools, search_notes: readTool } });
    turnRef = h.turn;
    const { text } = await h.send(userMsg('what notes?'));
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('only the work ones');
    expect(sse(text).find(c => c.type === 'data-steer')).toMatchObject({ id: 's1', data: { state: 'applied', text: 'only the work ones' } });
  });

  it('a steer that arrives after the last step comes back deferred, for the client to send next', async () => {
    const queue = memorySteerQueue();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        queue.push('c-1', { id: 's2', text: 'and thanks', userId: 'u-1', at: new Date().toISOString() });
        return textStream('Done.');
      },
    } as any);
    const { send } = harness({ model, steering: queue });
    const { text } = await send(userMsg('hi'));
    expect(sse(text).find(c => c.type === 'data-steer')).toMatchObject({ id: 's2', data: { state: 'deferred' } });
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain('and thanks');
  });

  it('applies at most 3 per turn and ignores other people’s steers', async () => {
    const queue = memorySteerQueue();
    for (let i = 1; i <= 4; i++) queue.push('c-1', { id: `s${i}`, text: `steer ${i}`, userId: 'u-1', at: '' });
    queue.push('c-1', { id: 'x', text: 'not yours', userId: 'u-2', at: '' });
    const model = mockModel(textStream('ok'));
    const { send } = harness({ model, steering: queue });
    const { text } = await send(userMsg('hi'));
    const s = sse(text).filter(c => c.type === 'data-steer');
    expect(s.map(c => [c.id, c.data.state])).toEqual([['s1', 'applied'], ['s2', 'applied'], ['s3', 'applied'], ['s4', 'deferred']]);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain('not yours');
  });

  it('rejects empty or oversized steers', async () => {
    const { turn } = harness({ model: mockModel(textStream('x')), steering: memorySteerQueue() });
    expect((await turn.steer({ conversationId: 'c-1', userId: 'u-1', text: '  ' })).status).toBe(400);
    expect((await turn.steer({ conversationId: 'c-1', userId: 'u-1', text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await turn.steer({ conversationId: 'c-1', userId: 'u-1', text: 'ok' })).status).toBe(202);
  });
});

describe('output cap', () => {
  it('caps every model step at 4,096 output tokens by default', async () => {
    const model = mockModel(toolStream(['c1', 'search_notes', {}]), textStream('One note.'));
    const { send } = harness({ model });
    await send(userMsg('what notes?'));
    expect(model.doStreamCalls).toHaveLength(2);
    for (const c of model.doStreamCalls) expect(c.maxOutputTokens).toBe(4096);
  });

  it('limits.maxOutputTokens overrides it, and 0 sends no cap', async () => {
    const a = mockModel(textStream('hi'));
    await harness({ model: a, limits: { maxOutputTokens: 1000 } }).send(userMsg('hi'));
    expect(a.doStreamCalls[0].maxOutputTokens).toBe(1000);
    const b = mockModel(textStream('hi'));
    await harness({ model: b, limits: { maxOutputTokens: 0 } }).send(userMsg('hi'));
    expect(b.doStreamCalls[0].maxOutputTokens).toBeUndefined();
  });
});

describe('provider failures are typed and readable', () => {
  const failing = (err: unknown) => new MockLanguageModelV4({ doStream: async () => { throw err; } } as any);
  const apiError = (statusCode: number, body: string) => new APICallError({
    message: body, url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: {}, statusCode, responseBody: JSON.stringify({ error: { message: body, code: statusCode } }), isRetryable: false,
  });

  it('an out-of-credit key ⇒ data-turn-error insufficient_credit, the same words as errorText, saved with the message', async () => {
    const { send } = harness({ model: failing(apiError(402, 'This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 25714.')) });
    const { res, text } = await send(userMsg('hi'));
    expect(res.status).toBe(200);
    const chunks = sse(text);
    const part = chunks.find(c => c.type === 'data-turn-error');
    expect(part.data).toMatchObject({ code: 'insufficient_credit', status: 402 });
    expect(part.data.message).toContain('out of credit');
    const err = chunks.find(c => c.type === 'error');
    expect(err.errorText).toBe(part.data.message);
    expect(chunks.indexOf(part)).toBeLessThan(chunks.indexOf(err));
    expect(partsOf('data-turn-error')[0].data.code).toBe('insufficient_credit');
    expect(receipts.at(-1)).toMatchObject({ outcome: 'error' });
  });

  it('a rejected key ⇒ invalid_key; anything else ⇒ failed with the old words', async () => {
    const a = sse((await harness({ model: failing(apiError(401, 'No auth credentials found')) }).send(userMsg('hi'))).text);
    expect(a.find(c => c.type === 'data-turn-error').data.code).toBe('invalid_key');
    const b = sse((await harness({ model: failing(new Error('socket hang up')) }).send(userMsg('hi'))).text);
    expect(b.find(c => c.type === 'data-turn-error').data).toMatchObject({ code: 'failed', message: 'The turn failed.' });
    expect(b.find(c => c.type === 'error').errorText).toBe('The turn failed.');
  });
});

describe('conversation titles (opt-in)', () => {
  const titles: Array<{ title: string; source: string }> = [];
  beforeEach(() => { titles.length = 0; });
  const titleOpts = (extra: Record<string, unknown> = {}) => ({
    needed: () => titles.length === 0,
    save: ({ title, source }: { title: string; source: string }) => { titles.push({ title, source }); },
    ...extra,
  });

  it('off by default: no title hook, no title', async () => {
    const { send } = harness({ model: mockModel(textStream('Hi.')) });
    await send(userMsg('why is the release stuck?'));
    expect(titles).toEqual([]);
  });

  it('titles a new question after the turn is saved, by rule, without a model call', async () => {
    const { send } = harness({ model: mockModel(textStream('It waits on review.')), title: titleOpts() });
    await send(userMsg('why is the release stuck?'));
    expect(titles).toEqual([{ title: 'Why is the release stuck?', source: 'rule' }]);
  });

  it('uses the app\'s title model for a long message, through `later`', async () => {
    const titleModel = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Export failures' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) as never });
    const scheduled: Array<() => Promise<void>> = [];
    const { send } = harness({
      model: mockModel(textStream('Looking.')),
      title: titleOpts({ model: async () => ({ ok: true, model: titleModel, plan: { ...plan, tier: 'budget' } }), later: (fn: () => Promise<void>) => { scheduled.push(fn); } }),
    });
    await send(userMsg('I need help figuring out why the nightly export keeps failing after the schema change'));
    expect(titles).toEqual([]);
    await Promise.all(scheduled.map(fn => fn()));
    expect(titles).toEqual([{ title: 'Export failures', source: 'model' }]);
  });

  it('skips when `needed` says no (the person named it)', async () => {
    titles.push({ title: 'Named by the person', source: 'user' });
    const { send } = harness({ model: mockModel(textStream('Hi.'), textStream('Hi.')), title: titleOpts() });
    await send(userMsg('why is the release stuck?'));
    expect(titles).toHaveLength(1);
  });
});
