/**
 * The kernel's span contract (docs/specs/workflow-kernel-library.md, Observability): the names and
 * attribute keys Axiom monitors query. A rename here is a monitor gone silent, so every key is pinned.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  KERNEL_SPAN, breakerSpanAttributes, callerOfRoute, commandCallerOf, commandOutcomeOf, commandSpanAttributes, doorSpanAttributes, emitKernelSpan,
  floorSpanAttributes, inferDoorCaller, passSpanAttributes, setKernelSpanSink, webCommandSpanAttributes, withKernelRoute, currentKernelRoute,
  type KernelSpanRecord,
} from './kernel-telemetry';
import {
  ControlPlaneUnavailableError, KernelCommandRefusedError, resetAttemptStartBreaker, resetKernelModeCache, type ClientDeps,
} from './kernel-client';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';
const OWN = { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s3cret' };

function capture() {
  const spans: KernelSpanRecord[] = [];
  setKernelSpanSink((s) => { spans.push(s); });
  return spans;
}

afterEach(() => {
  setKernelSpanSink(null);
  resetKernelModeCache();
  resetAttemptStartBreaker();
});

describe('span names', () => {
  it('are stable', () => {
    expect(KERNEL_SPAN).toEqual({
      door: 'kernel.door', breaker: 'kernel.breaker', webCommand: 'kernel.web_command', pass: 'kernel.pass', floor: 'kernel.floor', command: 'kernel.command',
    });
  });
});

describe('attribute contract', () => {
  it('a door call', () => {
    expect(doorSpanAttributes({ op: 'land', outcome: 'applied', latencyMs: 12.4, budgetMs: 20_000, caller: 'mcp', host: 'web' })).toEqual({
      'kernel.op': 'land', 'kernel.outcome': 'applied', 'kernel.latency_ms': 12, 'kernel.budget_ms': 20_000, 'kernel.caller': 'mcp', 'kernel.host': 'web',
    });
    expect(doorSpanAttributes({ op: 'land', outcome: 'refused', latencyMs: -1, budgetMs: 750, caller: 'claim', host: 'web', pass: 'claim_start', errorCode: 'forbidden' })).toEqual({
      'kernel.op': 'land', 'kernel.outcome': 'refused', 'kernel.latency_ms': 0, 'kernel.budget_ms': 750, 'kernel.caller': 'claim', 'kernel.host': 'web',
      'kernel.pass': 'claim_start', 'kernel.error_code': 'forbidden',
    });
  });

  it('the breaker', () => {
    expect(breakerSpanAttributes({ state: 'open', breaker: 'attempt_start', op: 'attempt_started', skipMs: 45_000, host: 'web' })).toEqual({
      'kernel.breaker.state': 'open', 'kernel.breaker': 'attempt_start', 'kernel.op': 'attempt_started', 'kernel.breaker.skip_ms': 45_000, 'kernel.host': 'web',
    });
    expect(breakerSpanAttributes({ state: 'closed', breaker: 'webhook', op: 'attempt_started', skipMs: 45_000, openMs: 60_000, host: 'web' })).toMatchObject({
      'kernel.breaker.state': 'closed', 'kernel.breaker.open_ms': 60_000,
    });
  });

  it('a command run on the web host: own-mode reasons say own', () => {
    expect(webCommandSpanAttributes({ op: 'land', reason: 'skew', latencyMs: 5 })).toEqual({
      'kernel.op': 'land', 'kernel.reason': 'skew', 'kernel.mode': 'own', 'kernel.latency_ms': 5, 'kernel.host': 'web',
    });
    for (const reason of ['not_host', 'unconfigured'] as const) expect(webCommandSpanAttributes({ op: 'land', reason, latencyMs: 0 })['kernel.mode']).toBe('own');
    for (const reason of ['shadow', 'no_command_key'] as const) expect(webCommandSpanAttributes({ op: 'land', reason, latencyMs: 0 })['kernel.mode']).toBe('shadow');
  });

  it('a pass', () => {
    expect(passSpanAttributes({ label: 'pr-reconcile:landing', budgetMs: 30_000, submitted: 4, refused: 2, drainsSkipped: 1, waitedMs: 29_999.6, host: 'web' })).toEqual({
      'kernel.pass': 'pr-reconcile:landing', 'kernel.budget_ms': 30_000, 'kernel.pass.submitted': 4, 'kernel.pass.refused': 2,
      'kernel.pass.drains_skipped': 1, 'kernel.pass.waited_ms': 30_000, 'kernel.host': 'web',
    });
  });

  it('a floor run, with and without the depth read', () => {
    const repairs = { factsImported: 1, effectsEnqueued: 2, trunkRecovered: 3, treadmillRestarted: 4, parkedAnswered: 5, parkedDead: 6 };
    expect(floorSpanAttributes({ host: 'control-plane', depth: { parked: 2, parkedOldestAgeS: 7200.2, effectsDue: 3, effectsOldestAgeS: 60 }, repairs, errors: 1 })).toEqual({
      'kernel.host': 'control-plane',
      'kernel.outbox.parked': 2, 'kernel.outbox.parked_oldest_age_s': 7200, 'kernel.outbox.effects_due': 3, 'kernel.outbox.effects_oldest_age_s': 60,
      'kernel.floor.repairs.facts_imported': 1, 'kernel.floor.repairs.effects_enqueued': 2, 'kernel.floor.repairs.trunk_recovered': 3,
      'kernel.floor.repairs.treadmill_restarted': 4, 'kernel.floor.repairs.parked_answered': 5, 'kernel.floor.repairs.parked_dead': 6,
      'kernel.floor.repairs.total': 15, 'kernel.floor.errors': 1,
    });
    const unread = floorSpanAttributes({ host: 'web', depth: null, repairs, errors: 0 });
    expect(unread['kernel.outbox.unread']).toBe(true);
    expect('kernel.outbox.parked' in unread).toBe(false);
  });

  it('a control-plane command', () => {
    expect(commandSpanAttributes({ op: 'land', status: 200, outcome: 'applied', latencyMs: 80, code: null })).toEqual({
      'kernel.op': 'land', 'kernel.outcome': 'applied', 'kernel.status': 200, 'kernel.latency_ms': 80, 'kernel.host': 'control-plane',
    });
    expect(commandSpanAttributes({ op: null, status: 401, outcome: 'refused', latencyMs: 1, code: 'unauthorized' })).toMatchObject({ 'kernel.op': 'unknown', 'kernel.error_code': 'unauthorized' });
    expect(commandOutcomeOf(200, { replayed: false })).toBe('applied');
    expect(commandOutcomeOf(200, { replayed: true })).toBe('replayed');
    expect(commandOutcomeOf(500, { code: 'command_failed' })).toBe('failed');
    expect(commandOutcomeOf(409, { code: 'in_progress' })).toBe('in_progress');
    expect(commandOutcomeOf(503, { code: 'ledger_unavailable' })).toBe('unavailable');
    expect(commandOutcomeOf(403, { code: 'forbidden' })).toBe('refused');
  });
});

describe('command caller diagnostics', () => {
  it('logs only fixed user-agent classes, never raw header values', () => {
    const cases = [
      ['buildd-kernel-client/1', 'buildd-web'], ['curl/8.1', 'curl'],
      ['Python-urllib/3.12', 'python'], ['node', 'node'],
      ['Mozilla/5.0 example', 'browser'], ['private-value', 'other'], ['', 'unknown'],
    ];
    for (const [agent, expected] of cases) {
      expect(commandCallerOf(new Headers({ 'user-agent': agent, authorization: 'secret-value' }))).toBe(expected);
    }
  });

  it('adds a caller class and fixed signature refusal reason to the command span', () => {
    expect(commandSpanAttributes({ op: null, status: 401, outcome: 'refused', code: 'unauthorized', latencyMs: 1, caller: 'curl', authFailure: 'missing' })).toMatchObject({
      'kernel.caller': 'curl', 'kernel.auth_failure': 'missing',
    });
  });
});

describe('the caller', () => {
  it('from the route', () => {
    expect(callerOfRoute('/api/github/webhook')).toBe('webhook');
    expect(callerOfRoute('/api/workers/claim')).toBe('claim');
    expect(callerOfRoute('/api/workers/[id]')).toBe('patch');
    expect(callerOfRoute('/api/workers/w-1')).toBe('patch');
    expect(callerOfRoute('/api/cron/pr-reconcile')).toBe('cron');
    expect(callerOfRoute('/api/mcp')).toBe('mcp');
    expect(callerOfRoute('/api/prs/[prNumber]/merge')).toBe('api');
    expect(callerOfRoute('/app/tasks/[id]')).toBe('dashboard');
    expect(callerOfRoute(null)).toBeNull();
  });

  it('explicit, then route, then pass, then principal', () => {
    const sys = (id: string) => ({ kind: 'system' as const, id });
    expect(inferDoorCaller({ explicit: 'cron', route: '/api/mcp', principal: null })).toBe('cron');
    expect(inferDoorCaller({ route: '/api/mcp', pass: 'claim_start', principal: null })).toBe('mcp');
    expect(inferDoorCaller({ pass: 'claim_start', principal: null })).toBe('claim');
    expect(inferDoorCaller({ pass: 'pr-reconcile:landing', principal: null })).toBe('cron');
    expect(inferDoorCaller({ principal: sys('system:webhook:closed') })).toBe('webhook');
    expect(inferDoorCaller({ principal: sys('system:sweep:pr-reconcile') })).toBe('cron');
    expect(inferDoorCaller({ principal: { kind: 'grant', id: 'a', grantId: 'g', workspaceIds: [], scopes: [] } as never })).toBe('mcp');
    expect(inferDoorCaller({ principal: { kind: 'user', id: USER } })).toBe('other');
  });

  it('the control plane names its route for the request', () => {
    expect(withKernelRoute('/api/workers/claim', () => currentKernelRoute())).toBe('/api/workers/claim');
  });
});

describe('emitting', () => {
  it('goes to the installed sink, and a throwing sink never reaches the caller', () => {
    const spans = capture();
    emitKernelSpan({ name: 'kernel.door', startMs: 1, durationMs: 2, attributes: { 'kernel.op': 'land' } });
    expect(spans).toHaveLength(1);
    setKernelSpanSink(() => { throw new Error('boom'); });
    expect(() => emitKernelSpan({ name: 'kernel.door', startMs: 1, durationMs: 2, attributes: {} })).not.toThrow();
  });

  it('without a sink, the OpenTelemetry API (a no-op tracer here) never throws', () => {
    expect(() => emitKernelSpan({ name: 'kernel.floor', startMs: Date.now(), durationMs: 0, attributes: { 'kernel.host': 'web' }, error: true })).not.toThrow();
  });
});

// ── Through the client ─────────────────────────────────────────────────────

const input = { workspaceId: WS, installationId: 1, repoFullName: 'acme/w', prNumber: 7, headSha: 'H1', door: 'dashboard', actor: `human:${USER}` };
const principal = { kind: 'user' as const, id: USER };
const refusedErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const answer = (o: Record<string, unknown> = {}) => Response.json({ v: 1, op: 'land', idempotencyKey: 'k', result: { merged: true }, delivery: { id: DELIVERY, version: 5 }, host: 'control-plane', replayed: false, ...o });

function local(extra: Partial<ClientDeps> = {}) {
  const ran: string[] = [];
  const deps: ClientDeps = {
    run: (async (op: string) => { ran.push(op); return { merged: true, outcome: 'merged' }; }) as ClientDeps['run'],
    deliveryAfter: async () => ({ id: DELIVERY, version: 4 }),
    sleep: async () => {},
    host: () => 'web',
    ...extra,
  };
  return { ran, deps };
}

const doors = (spans: KernelSpanRecord[]) => spans.filter((s) => s.name === 'kernel.door');

describe('door spans', () => {
  it('a door answered by the control plane: applied, with op, budget and caller', async () => {
    const spans = capture();
    const { landThroughKernel } = await import('./kernel-client');
    await withKernelRoute('/api/mcp', () => landThroughKernel(input as never, { principal, deps: local({ env: OWN, fetch: (async () => answer()) as never }).deps }));
    expect(doors(spans)).toHaveLength(1);
    expect(doors(spans)[0].attributes).toMatchObject({ 'kernel.op': 'land', 'kernel.outcome': 'applied', 'kernel.caller': 'mcp', 'kernel.host': 'web', 'kernel.budget_ms': 20_000 });
    expect(spans.some((s) => s.name === 'kernel.web_command')).toBe(false);
  });

  it('a door run on the web host because routing is off: applied, plus a web_command span saying why', async () => {
    const spans = capture();
    const { landThroughKernel } = await import('./kernel-client');
    const l = local({ env: {} });
    await landThroughKernel(input as never, { principal, deps: l.deps });
    expect(l.ran).toEqual(['land']);
    expect(doors(spans)[0].attributes['kernel.outcome']).toBe('applied');
    const web = spans.filter((s) => s.name === 'kernel.web_command');
    expect(web).toHaveLength(1);
    expect(web[0].attributes).toMatchObject({ 'kernel.op': 'land', 'kernel.reason': 'no_command_key', 'kernel.mode': 'shadow' });
  });

  it('a door the control plane never answers: parked when the op parks, unavailable otherwise, marked as an error', async () => {
    const spans = capture();
    const { landThroughKernel, claimFix } = await import('./kernel-client');
    let t = 0;
    const down = { env: OWN, fetch: (async () => { throw refusedErr(); }) as never, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; } };
    const parkedErr = await landThroughKernel(input as never, { principal, deps: local({ ...down, park: async () => true }).deps }).catch((e) => e);
    expect(parkedErr).toBeInstanceOf(ControlPlaneUnavailableError);
    expect(doors(spans).at(-1)!.attributes['kernel.outcome']).toBe(parkedErr.parked ? 'parked' : 'unavailable');
    expect(doors(spans).at(-1)!.error).toBe(true);
    await claimFix({ id: 't', workspaceId: WS } as never, { principal, deps: local(down).deps }).catch(() => null);
    expect(doors(spans).at(-1)!.attributes).toMatchObject({ 'kernel.op': 'claim_fix', 'kernel.outcome': 'unavailable' });
  });

  it('a refusal is refused, with the control plane\'s code', async () => {
    const spans = capture();
    const { landThroughKernel } = await import('./kernel-client');
    const refusing = (async () => Response.json({ v: 1, code: 'forbidden', error: 'no' }, { status: 403 })) as never;
    expect(await landThroughKernel(input as never, { principal, deps: local({ env: OWN, fetch: refusing }).deps }).catch((e) => e)).toBeInstanceOf(KernelCommandRefusedError);
    expect(doors(spans)[0].attributes).toMatchObject({ 'kernel.outcome': 'refused', 'kernel.error_code': 'forbidden' });
  });

  it('release skew: skew_fallback on the door, and a web_command span in own mode', async () => {
    const spans = capture();
    const { observeCiGreen } = await import('./kernel-client');
    const older = (async () => Response.json({ v: 1, code: 'bad_request', error: 'unknown op "observe_ci_green"' }, { status: 400 })) as never;
    const realError = console.error;
    console.error = () => {};
    try {
      await observeCiGreen({ workspaceId: WS, repoFullName: 'acme/w', prNumber: 7, headSha: 'H1' } as never, { principal, deps: local({ env: OWN, fetch: older }).deps });
    } finally {
      console.error = realError;
    }
    expect(doors(spans)).toHaveLength(1);
    expect(doors(spans)[0].attributes['kernel.outcome']).toBe('skew_fallback');
    const web = spans.filter((s) => s.name === 'kernel.web_command');
    expect(web.map((s) => s.attributes['kernel.reason'])).toEqual(['skew']);
    expect(web[0].attributes['kernel.mode']).toBe('own');
  });

  it('a control plane in shadow refusing as not_host: the web host runs it, own mode, reason not_host', async () => {
    const spans = capture();
    const { landThroughKernel } = await import('./kernel-client');
    const notHost = (async () => Response.json({ v: 1, code: 'not_host', error: 'x' }, { status: 409 })) as never;
    await landThroughKernel(input as never, { principal, deps: local({ env: OWN, fetch: notHost }).deps });
    expect(spans.filter((s) => s.name === 'kernel.web_command').map((s) => s.attributes['kernel.reason'])).toEqual(['not_host']);
  });
});

describe('the AttemptStarted breaker', () => {
  const start = { task: { id: 't-1', workspaceId: WS, deliveryId: DELIVERY, deliveryRole: 'owner', context: null }, claimedBy: USER, claimedAt: '2026-10-18 08:00:00+00', source: 'claim' };
  const runner = { kind: 'account' as const, id: USER, grant: null };

  it('opens once on an unanswered start, skipped starts read breaker_open, and the first answered start closes it', async () => {
    const spans = capture();
    const { attemptStarted, ATTEMPT_START_SKIP_MS, ATTEMPT_START_BUDGET_MS } = await import('./kernel-client');
    let t = 1_000_000;
    const down = (async () => { throw refusedErr(); }) as never;
    const deps = local({ env: OWN, fetch: down, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; } }).deps;
    await attemptStarted(start, { principal: runner, deps }).catch(() => null);
    await attemptStarted(start, { principal: runner, deps }).catch(() => null);
    const breaker = () => spans.filter((s) => s.name === 'kernel.breaker');
    expect(breaker().map((s) => s.attributes['kernel.breaker.state'])).toEqual(['open']);
    expect(breaker()[0].attributes['kernel.op']).toBe('attempt_started');
    expect(doors(spans).map((s) => s.attributes['kernel.outcome'])).toEqual(['unavailable', 'breaker_open']);
    expect(doors(spans).every((s) => s.attributes['kernel.caller'] === 'claim' && s.attributes['kernel.budget_ms'] === ATTEMPT_START_BUDGET_MS)).toBe(true);
    t += ATTEMPT_START_SKIP_MS + 1;
    const answered = (async () => answer({ op: 'attempt_started', result: { handled: true, started: true } })) as never;
    await attemptStarted(start, { principal: runner, deps: { ...deps, fetch: answered } });
    expect(breaker().map((s) => s.attributes['kernel.breaker.state'])).toEqual(['open', 'closed']);
    expect(Number(breaker()[1].attributes['kernel.breaker.open_ms'])).toBeGreaterThan(ATTEMPT_START_SKIP_MS);
    // A short door's own budget scope is not reported as a pass.
    expect(spans.some((s) => s.name === 'kernel.pass')).toBe(false);
  });
});

describe('pass spans', () => {
  it('a pass that ran out of budget is reported; one that did not is not', async () => {
    const spans = capture();
    const { withControlPlaneBudget } = await import('./kernel-client');
    await withControlPlaneBudget('pr-reconcile:landing', 1_000, async () => null);
    expect(spans.filter((s) => s.name === 'kernel.pass')).toHaveLength(0);
    let t = 0;
    const { landThroughKernel } = await import('./kernel-client');
    await withControlPlaneBudget("pr-reconcile:landing", 0, () => landThroughKernel(input as never, { principal, deps: local({ env: OWN, fetch: (async () => answer()) as never, now: () => t, park: async () => false }).deps }).catch(() => null), { now: () => t });
    const pass = spans.filter((s) => s.name === 'kernel.pass');
    expect(pass).toHaveLength(1);
    expect(pass[0].attributes).toMatchObject({ 'kernel.pass': 'pr-reconcile:landing', 'kernel.pass.refused': 1 });
    expect(doors(spans).at(-1)!.attributes).toMatchObject({ 'kernel.caller': 'cron', 'kernel.pass': 'pr-reconcile:landing' });
  });
});

describe('control-plane command spans', () => {
  it('one kernel.command per request the control plane answers: applied, then replayed for the same key, and a bad signature refused', async () => {
    const { handleCommandRequest } = await import('./command-api');
    const { submitKernelCommand } = await import('./kernel-client');
    const rows = new Map<string, { status: 'running' | 'done'; response: unknown; token: string; requestHash: string }>();
    const ledger = {
      claim: async (p: { key: string; token: string; requestHash: string }) => (rows.has(p.key) ? false : (rows.set(p.key, { status: 'running', response: null, token: p.token, requestHash: p.requestHash }), true)),
      renew: async (p: { key: string; token: string }) => rows.get(p.key)?.token === p.token,
      complete: async (p: { key: string; response: unknown }) => { const r = rows.get(p.key)!; r.status = 'done'; r.response = p.response; return true; },
      release: async (p: { key: string }) => { rows.delete(p.key); },
      read: async (k: string) => { const r = rows.get(k); return r ? { key: k, op: 'land', principal: '', requestHash: r.requestHash, status: r.status, response: r.response as never, claimedAt: '' } : null; },
      prune: async () => 0,
    };
    const deps = {
      env: OWN, host: () => 'control-plane' as const, ledger: ledger as never, reaches: async () => true, installationOf: async () => ({ installationId: 1 }),
      run: (async () => ({ merged: true })) as never, deliveryAfter: async () => ({ id: DELIVERY, version: 6 }),
    };
    const endpoint = (url: string, init: RequestInit) => handleCommandRequest(new Request(url, init), deps);
    const spans = capture();
    const opts = { principal, idempotencyKey: 'land:shared-key', deps: { ...local().deps, env: OWN, fetch: endpoint as unknown as typeof fetch } };
    await submitKernelCommand('land', input as never, opts);
    await submitKernelCommand('land', input as never, opts);
    await handleCommandRequest(new Request('https://control-plane.buildd.dev/v1/commands', { method: 'POST', body: '{}' }), deps);
    const commands = spans.filter((s) => s.name === 'kernel.command');
    expect(commands.map((s) => [s.attributes['kernel.op'], s.attributes['kernel.outcome'], s.attributes['kernel.status']])).toEqual([
      ['land', 'applied', 200], ['land', 'replayed', 200], ['unknown', 'refused', 401],
    ]);
    expect(commands[2].attributes['kernel.error_code']).toBe('unauthorized');
    expect(commands.every((s) => s.attributes['kernel.host'] === 'control-plane')).toBe(true);
  });

  it('classifies unauthorized curl callers and signature failures without exporting raw headers', async () => {
    const { handleCommandRequest } = await import('./command-api');
    const { signRequest } = await import('@buildd/dispatch-contract');
    const spans = capture();
    const url = 'https://control-plane.buildd.dev/v1/commands';
    const headers = await signRequest({ keyId: 'k1', secret: 'different-test-secret', method: 'POST', path: '/v1/commands', body: '{}' });
    for (const signature of [{}, headers]) {
      const res = await handleCommandRequest(new Request(url, {
        method: 'POST', body: '{}', headers: { ...signature, 'user-agent': 'curl/8.1 private-marker', authorization: 'Bearer private-marker' },
      }), { env: OWN, host: () => 'control-plane' });
      expect(res.status).toBe(401);
    }
    const commands = spans.filter((s) => s.name === 'kernel.command');
    expect(commands).toHaveLength(2);
    expect(commands.map((s) => s.attributes['kernel.auth_failure'])).toEqual(['missing', 'bad_signature']);
    for (const span of commands) {
      expect(span.attributes).toMatchObject({ 'kernel.caller': 'curl', 'kernel.error_code': 'unauthorized', 'kernel.status': 401, 'kernel.op': 'unknown' });
      expect(JSON.stringify(span)).not.toContain('private-marker');
      expect(JSON.stringify(span)).not.toContain(headers['Dispatch-Signature']);
    }
  });

  it('the web host answering the endpoint (not_host) reports nothing', async () => {
    const { handleCommandRequest } = await import('./command-api');
    const spans = capture();
    await handleCommandRequest(new Request('https://x/v1/commands', { method: 'POST', body: '{}' }), { env: OWN, host: () => 'web' });
    expect(spans).toEqual([]);
  });
});

describe('webhook door spans (the webhook budget)', () => {
  afterEach(async () => { (await import('./kernel-client')).resetWebhookBreaker(); });
  const green = (n: number) => ({ workspaceId: WS, repoFullName: 'acme/w', prNumber: n, headSha: `H${n}` });
  const webhook = { kind: 'system' as const, id: 'system:webhook:check_suite' };

  it('a capped door reads the webhook door cap as its budget; the first unanswered one opens the webhook breaker, the rest read breaker_open (still parked), and an answer closes it', async () => {
    const spans = capture();
    const { observeCiGreen, withWebhookBudget, WEBHOOK_DOOR_BUDGET_MS, WEBHOOK_SKIP_MS } = await import('./kernel-client');
    let t = 1_000_000;
    const deps = local({ env: OWN, fetch: (async () => { throw refusedErr(); }) as never, now: () => t, sleep: async (ms: number) => { t += ms + 5_000; }, park: async () => true }).deps;
    await withWebhookBudget('delivery-1', async () => {
      for (const n of [1, 2]) await observeCiGreen(green(n) as never, { principal: webhook, deps }).catch(() => null);
    }, { now: () => t });
    expect(doors(spans).map((s) => s.attributes['kernel.outcome'])).toEqual(['parked', 'breaker_open']);
    expect(doors(spans)[0].attributes).toMatchObject({ 'kernel.budget_ms': WEBHOOK_DOOR_BUDGET_MS, 'kernel.caller': 'webhook', 'kernel.pass': 'webhook' });
    expect(doors(spans)[1].attributes['kernel.error_code']).toBe('parked');
    const breaker = () => spans.filter((s) => s.name === 'kernel.breaker');
    expect(breaker().map((s) => [s.attributes['kernel.breaker'], s.attributes['kernel.breaker.state']])).toEqual([['webhook', 'open']]);
    t += WEBHOOK_SKIP_MS + 1;
    const answered = (async () => answer({ op: 'observe_ci_green', result: { handled: true } })) as never;
    await withWebhookBudget('delivery-2', () => observeCiGreen(green(3) as never, { principal: webhook, deps: { ...deps, fetch: answered } }), { now: () => t });
    expect(breaker().map((s) => s.attributes['kernel.breaker.state'])).toEqual(['open', 'closed']);
    expect(doors(spans).at(-1)!.attributes['kernel.outcome']).toBe('applied');
  });

  it('a door the webhook does not cap runs on its own budget, outside the pass, with exactly one door span', async () => {
    const spans = capture();
    const { landThroughKernel, withWebhookBudget, DOOR_BUDGET_MS } = await import('./kernel-client');
    await withWebhookBudget('delivery-3', () => landThroughKernel(input as never, { principal, deps: local({ env: OWN, fetch: (async () => answer()) as never }).deps }));
    expect(doors(spans)).toHaveLength(1);
    expect(doors(spans)[0].attributes['kernel.budget_ms']).toBe(DOOR_BUDGET_MS);
    expect('kernel.pass' in doors(spans)[0].attributes).toBe(false);
  });
});
