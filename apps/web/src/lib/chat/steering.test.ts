import { describe, it, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { approvalChangeLine, approvalHeadline, type ChatApprovalPreview } from '@buildd/shared';
import { buildChatTools, ENABLED_WRITE_OPS } from './tools';
import { buildPreview, type PreviewEnv } from './previews';
import { loadDocked } from './docked';
import { resolveTaskRef } from './targets';
import { chatReadRoutes, createInProcessApi, CHAT_ROUTES, type ApiCall, type ChatReach, type RouteEntry } from './in-process-api';

/**
 * Steering a mission from chat, end to end below the model: the tool, its
 * approval-card preview, the in-process API with the real reach guard and the
 * real route declarations, over fake route handlers holding a fictional
 * Harborline workspace. The model is left out on purpose — these are the
 * properties that must hold whatever it proposes.
 */

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WS = id(1);          // Harborline (standard, in reach)
const WS_SENS = id(2);     // Harborline payroll (sensitive)
const WS_OTHER = id(3);    // another team's workspace
const MISSION = id(10);
const MISSION_HELD = id(11);
const T_STRIPE = id(20), T_PAYPAL = id(21), T_EXPORT = id(22), T_GUIDE = id(23), T_ROUNDING = id(24);
const T_SENS = id(30), T_FOREIGN = id(31);
const W_DUNE = id(40), W_REEF = id(41), W_ASK = id(42);

type Obj = Record<string, any>;
let tasks: Record<string, Obj>;
let missions: Record<string, Obj>;
let writes: string[];

function reset() {
  writes = [];
  const t = (tid: string, title: string, status: string, extra: Obj = {}) => ({ id: tid, title, status, workspaceId: WS, missionId: MISSION, context: {}, workers: [], ...extra });
  tasks = {
    [T_STRIPE]: t(T_STRIPE, 'checkout · Stripe in currency', 'assigned', { workers: [{ id: W_DUNE, status: 'running', runner: 'dune' }] }),
    [T_PAYPAL]: t(T_PAYPAL, 'checkout · PayPal fallback', 'pending'),
    [T_EXPORT]: t(T_EXPORT, 'export · ledger CSV', 'assigned', { workers: [{ id: W_REEF, status: 'running', runner: 'reef' }] }),
    [T_GUIDE]: t(T_GUIDE, 'admin guide', 'pending'),
    [T_ROUNDING]: t(T_ROUNDING, 'rounding decision', 'assigned', {
      workers: [{ id: W_ASK, status: 'waiting_input', runner: 'dune', waitingFor: { type: 'question', prompt: 'Round per line or per invoice?' } }],
    }),
    [T_SENS]: { id: T_SENS, title: 'payroll export', status: 'pending', workspaceId: WS_SENS, context: {}, workers: [] },
    [T_FOREIGN]: { id: T_FOREIGN, title: 'checkout · other team', status: 'pending', workspaceId: WS_OTHER, context: {}, workers: [] },
  };
  missions = {
    [MISSION]: { id: MISSION, title: 'Multi-currency checkout', status: 'active', isHeld: false, teamId: 'team-hb', workspaceId: WS,
      goalCriteria: [{ type: 'command', label: 'EUR e2e passes', command: 'bun test e2e/eur' }] },
    [MISSION_HELD]: { id: MISSION_HELD, title: 'Rounding rollout', status: 'active', isHeld: true, teamId: 'team-hb', workspaceId: WS, goalCriteria: [] },
  };
}

const missionView = (m: Obj) => ({ ...m, tasks: Object.values(tasks).filter(t => t.missionId === m.id).map(({ workers: _w, ...t }) => t) });
const json = (b: unknown, status = 200) => Response.json(b, { status });
const params = async (ctx: any) => ctx.params as Promise<Record<string, string>>;

const HANDLERS: Record<string, Obj> = {
  '/api/tasks': {
    GET: async () => json({ tasks: Object.values(tasks).filter(t => !['completed', 'cancelled'].includes(t.status)).map(({ workers: _w, ...t }) => t) }),
    POST: async (req: NextRequest) => {
      const body = await req.json();
      writes.push(`POST /api/tasks ${JSON.stringify({ missionId: body.missionId, dependsOn: body.dependsOn, creationSource: body.creationSource, baseBranch: body.context?.baseBranch })}`);
      const tid = id(99);
      tasks[tid] = { id: tid, title: body.title, status: 'pending', workspaceId: body.workspaceId, missionId: body.missionId, context: {}, workers: [] };
      return json({ ...tasks[tid], priority: 5 });
    },
  },
  '/api/tasks/:id': {
    GET: async (_r: NextRequest, ctx: any) => { const t = tasks[(await params(ctx)).id]; return t ? json(t) : json({ error: 'Task not found' }, 404); },
    PATCH: async (req: NextRequest, ctx: any) => {
      const { id: tid } = await params(ctx);
      const body = await req.json();
      writes.push(`PATCH /api/tasks/${tid.slice(0, 8)} ${JSON.stringify(body)}`);
      const t = tasks[tid];
      if (body.held === true) t.context = { ...t.context, heldBy: { at: 'now', userId: 'u-1' } };
      if (body.held === false) { const { heldBy: _h, ...rest } = t.context; t.context = rest; }
      if (body.status) t.status = body.status;
      if (body.title) t.title = body.title;
      return json({ ...t, priority: 5 });
    },
  },
  '/api/missions/:id': {
    GET: async (_r: NextRequest, ctx: any) => { const m = missions[(await params(ctx)).id]; return m ? json(missionView(m)) : json({ error: 'Mission not found' }, 404); },
    PATCH: async (req: NextRequest, ctx: any) => {
      const { id: mid } = await params(ctx);
      const body = await req.json();
      writes.push(`PATCH /api/missions/${mid.slice(0, 8)} ${JSON.stringify(body)}`);
      const m = missions[mid];
      if (body.arm) m.isHeld = false;
      if (body.goalCriteria) m.goalCriteria = body.goalCriteria;
      if (body.status) m.status = body.status;
      return json(m);
    },
    DELETE: async () => { writes.push('DELETE mission'); return json({ ok: true }); },
  },
  '/api/missions/capabilities': { GET: async () => json({ capabilities: ['startMode', 'pacing'] }) },
  '/api/workers/:id/instruct': {
    POST: async (req: NextRequest, ctx: any) => {
      const body = await req.json();
      writes.push(`POST instruct ${(await params(ctx)).id.slice(0, 8)} ${body.priority ?? 'normal'}: ${String(body.message).slice(0, 40)}`);
      return json({ message: 'Queued', deliveryState: 'pending' });
    },
  },
  '/api/workers/:id/respond': {
    POST: async (req: NextRequest, ctx: any) => {
      const body = await req.json();
      writes.push(`POST respond ${(await params(ctx)).id.slice(0, 8)}: ${body.message}`);
      return json({ ok: true });
    },
  },
  '/api/workspaces': { GET: async () => json({ workspaces: [{ id: WS, name: 'harborline-web' }, { id: WS_SENS, name: 'harborline-payroll' }, { id: WS_OTHER, name: 'elsewhere' }] }) },
  '/api/workspaces/:id/schedules': {
    POST: async (req: NextRequest) => { const b = await req.json(); writes.push(`POST schedule ${b.name} ${b.cronExpression} ${b.timezone ?? ''}`); return json({ schedule: { id: id(70), name: b.name, workspaceId: WS } }); },
  },
};

const ROUTES: RouteEntry[] = CHAT_ROUTES.filter(r => HANDLERS[r.pattern]).map(r => ({ ...r, load: async () => HANDLERS[r.pattern] }));

const owners: Record<string, { teamId: string | null; workspaceId: string | null; childWorkspaceIds?: string[] }> = {};
const reach: ChatReach = {
  teamId: 'team-hb',
  workspaceIds: new Set([WS]),
  ownerOf: async (kind, oid) => {
    if (kind === 'task') { const t = tasks[oid]; return t ? { teamId: t.workspaceId === WS_OTHER ? 'team-other' : 'team-hb', workspaceId: t.workspaceId } : null; }
    if (kind === 'mission') { const m = missions[oid]; return m ? { teamId: m.teamId, workspaceId: m.workspaceId, childWorkspaceIds: [WS] } : null; }
    if (kind === 'worker') {
      const t = Object.values(tasks).find(x => x.workers.some((w: Obj) => w.id === oid));
      return t ? { teamId: null, workspaceId: t.workspaceId } : null;
    }
    return owners[`${kind}:${oid}`] ?? null;
  },
};

function makeApi(onCall: (c: ApiCall) => void, opts?: { routes?: readonly RouteEntry[] }) {
  const allowed = opts?.routes
    ? ROUTES.map(r => { const o = opts.routes!.find(x => x.pattern === r.pattern); return o ? { ...r, methods: o.methods } : null; }).filter(Boolean) as RouteEntry[]
    : ROUTES;
  return createInProcessApi({ origin: 'http://localhost', headers: new Headers({ cookie: 's=1' }), reach, routes: allowed, onCall });
}

const read = makeApi(() => {}, { routes: chatReadRoutes() });
const docked: PreviewEnv = { read, scope: { missionId: MISSION, missionTitle: 'Multi-currency checkout', workspaceId: WS } };

function toolsFor(opts: { authorized?: string[]; previews?: Map<string, ChatApprovalPreview>; canAdmin?: boolean } = {}) {
  return buildChatTools({
    ctx: { workspaceId: WS, teamId: 'team-hb', getWorkspaceId: async () => WS, getLevel: async () => 'admin' } as any,
    makeApi,
    allowWrites: true,
    canAdmin: opts.canAdmin ?? false,
    authorizedToolCallIds: new Set(opts.authorized ?? []),
    approvedPreviews: opts.previews ?? new Map(),
    preview: (tool, input) => buildPreview(tool, input, docked, { confirmAdmin: tool === 'manage_missions' && input.action === 'delete' }),
    resolveTask: ref => resolveTaskRef(read, ref, docked.scope),
  });
}

/** Propose (build the card), then approve that exact card and execute. */
async function proposeAndApprove(tool: string, input: Obj, opts: { canAdmin?: boolean } = {}) {
  const p = await buildPreview(tool, input, docked);
  if (!p.ok) throw new Error(`expected a card, got a question: ${p.question}`);
  const tools = toolsFor({ authorized: ['call-1'], previews: new Map([['call-1', p.preview]]), canAdmin: opts.canAdmin });
  const out = await (tools[tool] as any).execute(input, { toolCallId: 'call-1', messages: [] });
  return { preview: p.preview, out };
}

beforeEach(reset);

describe('the owner\'s examples', () => {
  it('"Pause checkout until the rounding decision is in" → ambiguous: a question, no card, no write', async () => {
    const p = await buildPreview('hold_task', { taskId: 'checkout', reason: 'until the rounding decision is in' }, docked);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.question).toContain('matches 2 tasks');
      expect(p.question).toContain('checkout · Stripe in currency');
      expect(p.question).toContain('checkout · PayPal fallback');
      expect(p.question).toContain("don't pick");
    }
    const out = await (toolsFor().hold_task as any).execute({ taskId: 'checkout' }, { toolCallId: 'c', messages: [] });
    expect(out.data).toStartWith('Needs clarification');
    expect(writes).toEqual([]);
  });

  it('"Pause the Stripe checkout…" → Hold task card; approving holds it and tells the running agent', async () => {
    const { preview, out } = await proposeAndApprove('hold_task', { taskId: 'stripe checkout', reason: 'until the rounding decision is in' });
    expect(approvalHeadline(preview)).toBe('Hold task: checkout · Stripe in currency (running on dune)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Claims: open → held', 'Until: + until the rounding decision is in']);
    expect(preview.note).toBe('The agent running on dune is told to stop at a safe point and wait.');
    expect(writes).toEqual([
      `PATCH /api/tasks/${T_STRIPE.slice(0, 8)} {"held":true,"heldReason":"until the rounding decision is in"}`,
      `POST instruct ${W_DUNE.slice(0, 8)} urgent: HOLD: a person put this task on hold (un`,
    ]);
    expect(out.objects[0]).toMatchObject({ kind: 'task', id: T_STRIPE });
  });

  it('resume is the same tool with hold:false', async () => {
    tasks[T_STRIPE].context = { heldBy: { at: 'then' } };
    const { preview } = await proposeAndApprove('hold_task', { taskId: T_STRIPE, hold: false });
    expect(approvalHeadline(preview)).toBe('Resume task: checkout · Stripe in currency (held)');
    expect(writes[0]).toContain('{"held":false}');
    expect(writes[1]).toContain('RESUME');
  });

  it('"Tell the export agent to also add a rounding_delta column" → message card, one instruct', async () => {
    const { preview, out } = await proposeAndApprove('send_agent_message', { taskId: 'export', message: 'Also add a rounding_delta column to the ledger CSV.', priority: 'urgent' });
    expect(approvalHeadline(preview)).toBe('Message the agent on: export · ledger CSV (running on reef)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Message: + Also add a rounding_delta column to the ledger CSV.']);
    expect(writes).toEqual([`POST instruct ${W_REEF.slice(0, 8)} urgent: Also add a rounding_delta column to the `]);
    expect(out.objects.some((o: Obj) => o.kind === 'task' && o.id === T_EXPORT)).toBe(true);
  });

  it('a message to a task with no running agent asks instead (offer a follow-up task)', async () => {
    const p = await buildPreview('send_agent_message', { taskId: 'admin guide', message: 'x' }, docked);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.question).toContain('follow-up task');
  });

  it('"Drop the admin guide" → Cancel task card; approving cancels exactly that task', async () => {
    const { preview } = await proposeAndApprove('update_task', { taskId: 'admin guide', status: 'cancelled' });
    expect(approvalHeadline(preview)).toBe('Cancel task: admin guide (pending)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Status: pending → cancelled']);
    expect(writes).toEqual([`PATCH /api/tasks/${T_GUIDE.slice(0, 8)} {"status":"cancelled"}`]);
  });

  it('"…add a JPY e2e test instead" → New task in the mission, after the Stripe task, filed as dashboard work', async () => {
    const { preview } = await proposeAndApprove('create_task', {
      title: 'JPY e2e test', description: 'Cover zero-decimal JPY through checkout.', dependsOn: ['stripe checkout'],
    });
    expect(approvalHeadline(preview)).toBe('New task in: Multi-currency checkout');
    expect(preview.changes.map(approvalChangeLine)).toEqual([
      'Title: + JPY e2e test', 'Brief: + Cover zero-decimal JPY through checkout.', 'After: + checkout · Stripe in currency',
    ]);
    expect(writes).toEqual([`POST /api/tasks {"missionId":"${MISSION}","dependsOn":["${T_STRIPE}"],"creationSource":"dashboard"}`]);
  });

  it('"The EUR footnote is wrong, fix it before merging" → a follow-up task on the same branch', async () => {
    const { preview } = await proposeAndApprove('create_task', {
      title: 'Fix the EUR footnote', description: 'The review screenshot shows the wrong EUR footnote.', baseBranch: 'buildd/stripe-currency',
    });
    expect(preview.changes.map(approvalChangeLine)).toContain('Branch: + buildd/stripe-currency');
    expect(writes[0]).toContain('"baseBranch":"buildd/stripe-currency"');
  });

  it('"Add JPY e2e to the goal" → Edit mission card with a criteria diff', async () => {
    const { preview } = await proposeAndApprove('manage_missions', {
      action: 'update',
      goalCriteria: [
        { type: 'command', label: 'EUR e2e passes', command: 'bun test e2e/eur' },
        { type: 'command', label: 'JPY e2e passes', command: 'bun test e2e/jpy' },
      ],
    });
    expect(approvalHeadline(preview)).toBe('Edit mission: Multi-currency checkout (active)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Goal criteria: + JPY e2e passes']);
    expect(writes[0]).toStartWith(`PATCH /api/missions/${MISSION.slice(0, 8)}`);
  });

  it('addGoalCriteria appends to the CURRENT list (nothing the model couldn\'t see is dropped)', async () => {
    const { preview } = await proposeAndApprove('manage_missions', {
      action: 'update', addGoalCriteria: [{ type: 'command', label: 'JPY e2e passes', command: 'bun test e2e/jpy' }],
    });
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Goal criteria: + JPY e2e passes']);
    const body = JSON.parse(writes[0].slice(writes[0].indexOf('{')));
    expect(body.goalCriteria.map((c: Obj) => c.label)).toEqual(['EUR e2e passes', 'JPY e2e passes']);
    expect(body.goalCriteria[0].command).toBe('bun test e2e/eur');
    expect(body.addGoalCriteria).toBeUndefined();
  });

  it('arming a held mission', async () => {
    const { preview } = await proposeAndApprove('manage_missions', { action: 'arm', missionId: MISSION_HELD });
    expect(approvalHeadline(preview)).toBe('Arm mission: Rounding rollout (held)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Start: held → armed']);
    expect(writes).toEqual([`PATCH /api/missions/${MISSION_HELD.slice(0, 8)} {"arm":true}`]);
  });

  it('answering (or re-answering) the waiting question', async () => {
    const { preview } = await proposeAndApprove('answer_question', { taskId: 'rounding', answer: 'Per line.' });
    expect(approvalHeadline(preview)).toBe('Answer the question on: rounding decision (waiting for your answer)');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Round per line or per invoice?: + Per line.']);
    expect(writes).toEqual([`POST respond ${W_ASK.slice(0, 8)}: Per line.`]);
  });

  it('"schedule a weekly dependency sweep" → New schedule card', async () => {
    const { preview } = await proposeAndApprove('create_schedule', { name: 'Weekly dependency sweep', cronExpression: '0 9 * * 1', timezone: 'Pacific/Auckland', title: 'Dependency sweep' });
    expect(approvalHeadline(preview)).toBe('New schedule in: harborline-web');
    expect(preview.changes.map(approvalChangeLine)).toEqual(['Name: + Weekly dependency sweep', 'Runs: + 0 9 * * 1 (Pacific/Auckland)', 'Each run files: + Dependency sweep']);
    expect(writes).toEqual(['POST schedule Weekly dependency sweep 0 9 * * 1 Pacific/Auckland']);
  });
});

describe('inputs the way models actually send them', () => {
  it('hold as the string "false" resumes; dependsOn and pathManifest as one string are lists of one', async () => {
    tasks[T_STRIPE].context = { heldBy: { at: 'then' } };
    const { preview } = await proposeAndApprove('hold_task', { taskId: T_STRIPE, hold: 'false' });
    expect(preview.verb).toBe('Resume task');
    expect(writes[0]).toContain('{"held":false}');
    writes = [];
    const created = await proposeAndApprove('create_task', { title: 'JPY e2e', description: 'x', dependsOn: 'export', pathManifest: 'e2e/pay-jpy.spec.ts' });
    expect(created.preview.changes.map(approvalChangeLine)).toContain('After: + export · ledger CSV');
    expect(created.preview.changes.map(approvalChangeLine)).toContain('Paths: + e2e/pay-jpy.spec.ts');
    expect(writes[0]).toContain(`"dependsOn":["${T_EXPORT}"]`);
  });

  it('a runner registered by URL reads as its host name on the card', async () => {
    tasks[T_EXPORT].workers[0].runner = 'http://reef.local:8766';
    const p = await buildPreview('send_agent_message', { taskId: 'export', message: 'hi' }, docked);
    if (!p.ok) throw new Error('card expected');
    expect(approvalHeadline(p.preview)).toBe('Message the agent on: export · ledger CSV (running on reef)');
  });
});

describe('reads name tasks the way the docked list shows them', () => {
  it('get_task with a short id or words resolves to the one task; several matches ask', async () => {
    const tools = toolsFor();
    const byShort = await (tools.get_task as any).execute({ taskId: T_EXPORT.slice(0, 8) }, { toolCallId: 'r1', messages: [] });
    expect(byShort.data).not.toContain('Needs clarification');
    expect(byShort.data).toContain('export · ledger CSV');
    const ambiguous = await (tools.get_task as any).execute({ taskId: 'checkout' }, { toolCallId: 'r2', messages: [] });
    expect(ambiguous.data).toStartWith('Needs clarification');
  });
});

describe('reach: the target is checked before the card and again at the write', () => {
  it('a sensitive workspace\'s task gets no card and no write', async () => {
    const p = await buildPreview('hold_task', { taskId: T_SENS }, docked);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.question).toContain("isn't available here");
    const tools = toolsFor({ authorized: ['c'] });
    const out = await (tools.update_task as any).execute({ taskId: T_SENS, status: 'cancelled' }, { toolCallId: 'c', messages: [] });
    expect(out.data).toContain('nothing changed');
    expect(writes).toEqual([]);
  });

  it('another team\'s task (same user, other team) gets no card and no write', async () => {
    const p = await buildPreview('send_agent_message', { taskId: T_FOREIGN, message: 'x' }, docked);
    expect(p.ok).toBe(false);
    const out = await (toolsFor({ authorized: ['c'] }).send_agent_message as any).execute({ taskId: T_FOREIGN, message: 'x' }, { toolCallId: 'c', messages: [] });
    expect(out.data).toContain('nothing changed');
    expect(writes).toEqual([]);
  });

  it('a crafted dock for another team\'s or a sensitive mission docks nothing and reads nothing', async () => {
    missions[id(12)] = { id: id(12), title: 'Other team roadmap', status: 'active', teamId: 'team-other', workspaceId: WS_OTHER };
    missions[id(13)] = { id: id(13), title: 'Payroll', status: 'active', teamId: 'team-hb', workspaceId: WS_SENS };
    expect(await loadDocked(read, { kind: 'mission', id: id(12) }, null)).toBeNull();
    expect(await loadDocked(read, { kind: 'mission', id: id(13) }, null)).toBeNull();
    expect(await loadDocked(read, { kind: 'task', id: T_SENS }, null)).toBeNull();
    const ok = await loadDocked(read, { kind: 'mission', id: MISSION }, null);
    expect(ok?.tasks.map(t => t.title)).toContain('checkout · Stripe in currency');
  });

  it('a schedule for a sensitive workspace, named by its name, gets a question, not a card', async () => {
    const p = await buildPreview('create_schedule', { name: 'n', cronExpression: '0 9 * * 1', workspaceId: 'harborline-payroll' }, docked);
    expect(p.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('a write body that points at an out-of-reach object is refused by the route guard', async () => {
    const p = await buildPreview('create_task', { title: 'x', description: 'y', dependsOn: [T_SENS] }, docked);
    expect(p.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('approval binding', () => {
  it('a card approved for one call authorizes no other call', async () => {
    const p = await buildPreview('hold_task', { taskId: T_STRIPE }, docked);
    if (!p.ok) throw new Error('card expected');
    const tools = toolsFor({ authorized: ['call-other'], previews: new Map([['call-other', p.preview]]) });
    const out = await (tools.hold_task as any).execute({ taskId: T_STRIPE }, { toolCallId: 'call-1', messages: [] });
    expect(out.data).toContain('not approved');
    expect(writes).toEqual([]);
  });

  it('you approve what you saw: a target that changed after the card runs nothing', async () => {
    const p = await buildPreview('update_task', { taskId: T_GUIDE, status: 'cancelled' }, docked);
    if (!p.ok) throw new Error('card expected');
    tasks[T_GUIDE].status = 'assigned'; // someone started it meanwhile
    const tools = toolsFor({ authorized: ['c'], previews: new Map([['c', p.preview]]) });
    const out = await (tools.update_task as any).execute({ taskId: T_GUIDE, status: 'cancelled' }, { toolCallId: 'c', messages: [] });
    expect(out.data).toContain('changed since the card was shown');
    expect(writes).toEqual([]);
  });

  it('an authorized call with no stored card runs nothing', async () => {
    const out = await (toolsFor({ authorized: ['c'] }).hold_task as any).execute({ taskId: T_STRIPE }, { toolCallId: 'c', messages: [] });
    expect(out.data).toContain('nothing changed');
    expect(writes).toEqual([]);
  });

  it('admin writes: a member can\'t; an admin\'s card asks for the target\'s name', async () => {
    const member = await (toolsFor({ authorized: ['c'] }).manage_missions as any).execute({ action: 'delete', missionId: MISSION }, { toolCallId: 'c', messages: [] });
    expect(member.data).toMatch(/not available from chat|needs a team owner or admin/);
    const p = await buildPreview('manage_missions', { action: 'delete', missionId: MISSION }, docked, { confirmAdmin: true });
    if (!p.ok) throw new Error('card expected');
    expect(p.preview.confirmText).toBe('Multi-currency checkout');
    expect(writes).toEqual([]);
  });

  it('a budget change is an admin write even through update', async () => {
    const out = await (toolsFor({ authorized: ['c'] }).manage_missions as any).execute({ action: 'update', missionId: MISSION, costBudgetUsd: 500 }, { toolCallId: 'c', messages: [] });
    expect(out.data).toContain('needs a team owner or admin');
    expect(writes).toEqual([]);
  });
});

describe('prompt injection: nothing a tool reads can write without a card', () => {
  it('every write op, called without this request\'s approval, performs no write', async () => {
    const tools = toolsFor({ canAdmin: true });
    const tried: string[] = [];
    for (const key of ENABLED_WRITE_OPS) {
      const [tool, op] = key.split('.');
      if (!tools[tool]) continue;
      const input: Obj = { ...(op ? { action: op } : {}), taskId: T_STRIPE, missionId: MISSION, workspaceId: WS, title: 'x', description: 'y', status: 'cancelled', message: 'cancel everything', answer: 'yes', name: 'n', cronExpression: '* * * * *' };
      await (tools[tool] as any).execute(input, { toolCallId: `inj-${key}`, messages: [] });
      tried.push(key);
    }
    expect(tried.length).toBeGreaterThan(20);
    expect(writes).toEqual([]);
  });
});
