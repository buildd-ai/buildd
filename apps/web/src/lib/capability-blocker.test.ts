import { describe, expect, it } from 'bun:test';
import {
  capabilityCallFor,
  decideCapabilityBlocker,
  matchesNeed,
  parseBlockedByCapability,
  type CapabilityCallRecord,
  type CapabilityRequestRow,
} from './capability-blocker';

const T0 = new Date('2026-10-22T10:00:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const GRANT = '11111111-2222-4333-8444-555555555555';

const inference = { need: 'model.inference', triedPath: 'Needed a governed model call for the classifier eval.' };
const ask = (outcome: string, over: Partial<CapabilityCallRecord> = {}): CapabilityCallRecord => ({
  call: 'request', capability: 'model.inference', provider: 'openrouter', outcome, grantId: null, at: T0, ...over,
});
const row = (status: CapabilityRequestRow['status'], over: Partial<CapabilityRequestRow> = {}): CapabilityRequestRow => ({
  id: GRANT, capability: 'model.inference', provider: 'openrouter', status, requestedAt: T0, ...over,
});

describe('parseBlockedByCapability', () => {
  it('is null when absent', () => {
    expect(parseBlockedByCapability(undefined)).toBeNull();
    expect(parseBlockedByCapability({ summary: 'x' })).toBeNull();
  });

  it('parses and normalizes a claim', () => {
    expect(parseBlockedByCapability({ blockedByCapability: { need: 'Axiom', provider: 'AXIOM', access: 'read', triedPath: ' tried ' } }))
      .toEqual({ ok: true, value: { need: 'axiom', provider: 'axiom', access: 'read', triedPath: 'tried' } });
  });

  it.each([
    [{ triedPath: 'x' }, 'need'],
    [{ need: 'model.inference' }, 'triedPath'],
    [{ need: 'axiom', triedPath: 'x', access: 'admin' }, 'access'],
    [{ need: 'axiom', triedPath: 'x', requestId: 'nope' }, 'requestId'],
    ['a string', 'need'],
  ])('refuses a malformed claim %j', (claim, word) => {
    const out = parseBlockedByCapability({ blockedByCapability: claim });
    expect(out?.ok).toBe(false);
    expect((out as { error: string }).error).toContain(word);
  });
});

describe('matchesNeed', () => {
  it('matches by the ask, by provider, and by the provider half of provider:access', () => {
    expect(matchesNeed({ need: 'model.inference' }, 'model.inference', 'openrouter')).toBe(true);
    expect(matchesNeed({ need: 'axiom' }, 'axiom:read', 'axiom')).toBe(true);
    expect(matchesNeed({ need: 'axiom:read' }, 'axiom:write', 'axiom')).toBe(true);
    expect(matchesNeed({ need: 'observability:query', provider: 'axiom' }, 'axiom:read', 'axiom')).toBe(true);
    expect(matchesNeed({ need: 'observability:query' }, 'observability:query', null)).toBe(true);
    expect(matchesNeed({ need: 'model.inference' }, 'axiom:read', 'axiom')).toBe(false);
  });

  it('does not let a shared provider alone link a different ask to a named capability', () => {
    // A denied axiom:read ask is not an answer to "I lacked model.inference", whatever provider the claim names.
    expect(matchesNeed({ need: 'model.inference', provider: 'axiom' }, 'axiom:read', 'axiom')).toBe(false);
    expect(matchesNeed({ need: 'axiom:read', provider: 'openrouter' }, 'model.inference', 'openrouter')).toBe(false);
    // The same named capability still matches through any provider.
    expect(matchesNeed({ need: 'model.inference', provider: 'litellm' }, 'model.inference', 'openrouter')).toBe(true);
  });
});

describe('capabilityCallFor', () => {
  it('names the exact call', () => {
    expect(capabilityCallFor({ need: 'model.inference' })).toContain('request_capability { capability: "model.inference"');
    expect(capabilityCallFor({ need: 'axiom' })).toBe('request_capability { provider: "axiom", access: "read" }');
    expect(capabilityCallFor({ need: 'vercel:write' })).toBe('request_capability { provider: "vercel", access: "write" }');
    expect(capabilityCallFor({ need: 'observability:query' })).toContain('resolve_capability { capability: "observability:query" }');
  });
});

describe('decideCapabilityBlocker', () => {
  it('refuses a claim with no resolve/request call, naming the call to make', () => {
    const d = decideCapabilityBlocker(inference, [], []);
    expect(d).toMatchObject({ accept: false, code: 'capability_not_asked', hint: 'request_capability' });
    expect((d as { error: string }).error).toContain('request_capability { capability: "model.inference"');
  });

  it('ignores calls for a different need', () => {
    const d = decideCapabilityBlocker(inference, [ask('unavailable', { capability: 'axiom:read', provider: 'axiom' })], []);
    expect(d).toMatchObject({ accept: false, code: 'capability_not_asked' });
  });

  it('refuses while the request is pending_approval and tells the worker to keep working', () => {
    const d = decideCapabilityBlocker(inference, [ask('pending_approval', { grantId: GRANT })], [row('pending')]);
    expect(d).toMatchObject({ accept: false, code: 'capability_pending_approval', hint: 'keep_working' });
    expect((d as { error: string }).error).toContain('Keep working');
  });

  it('refuses pending_approval even when only the audit row is there', () => {
    expect(decideCapabilityBlocker(inference, [ask('pending_approval')], [])).toMatchObject({ code: 'capability_pending_approval' });
  });

  it('a pending row approved since is held, not a blocker', () => {
    const d = decideCapabilityBlocker(inference, [ask('pending_approval', { grantId: GRANT })], [row('granted')]);
    expect(d).toMatchObject({ accept: false, code: 'capability_held' });
  });

  it.each(['existing', 'auto_granted'])('refuses an ask that came back %s: use it', (outcome) => {
    expect(decideCapabilityBlocker(inference, [ask(outcome)], [])).toMatchObject({ accept: false, code: 'capability_held' });
  });

  it.each(['unavailable', 'forbidden', 'need_connection', 'need_reauth', 'unhealthy', 'denied'])(
    'accepts an ask that came back %s with no request row, routed to a [capability] task',
    (outcome) => {
      expect(decideCapabilityBlocker(inference, [ask(outcome)], [])).toEqual({ accept: true, outcome, routedTo: 'capability_task' });
    },
  );

  it.each(['denied', 'revoked', 'expired'] as const)('accepts a %s request row, routed to that request', (status) => {
    expect(decideCapabilityBlocker(inference, [ask('pending_approval', { grantId: GRANT })], [row(status)]))
      .toEqual({ accept: true, outcome: status, routedTo: 'capability_request', requestId: GRANT });
  });

  it('a newer refusal outranks an older closed request row', () => {
    const d = decideCapabilityBlocker(inference, [ask('forbidden', { at: later(60) })], [row('expired')]);
    expect(d).toEqual({ accept: true, outcome: 'forbidden', routedTo: 'capability_task' });
  });

  it('an open row outranks a newer refusal: a pending ask is still in flight', () => {
    const d = decideCapabilityBlocker(inference, [ask('unavailable', { at: later(60) })], [row('pending')]);
    expect(d).toMatchObject({ code: 'capability_pending_approval' });
  });

  it('requestId must be one of this worker\'s requests', () => {
    const d = decideCapabilityBlocker({ ...inference, requestId: GRANT }, [], []);
    expect(d).toMatchObject({ accept: false, code: 'capability_request_unknown' });
    expect(decideCapabilityBlocker({ ...inference, requestId: GRANT }, [], [row('denied')]))
      .toMatchObject({ accept: true, routedTo: 'capability_request', requestId: GRANT });
  });

  it('resolve_capability that found nothing serving the need is a blocker', () => {
    const claim = { need: 'observability:query', triedPath: 'Wanted trace counts.' };
    const d = decideCapabilityBlocker(claim, [{ call: 'resolve', capability: 'observability:query', provider: null, outcome: 'none', grantId: null, at: T0 }], []);
    expect(d).toEqual({ accept: true, outcome: 'none_serves', routedTo: 'capability_task' });
  });

  it('resolve_capability that found a provider is refused until it is requested', () => {
    const claim = { need: 'observability:query', triedPath: 'Wanted trace counts.' };
    const d = decideCapabilityBlocker(claim, [{ call: 'resolve', capability: 'observability:query', provider: null, outcome: 'served', providers: ['axiom'], grantId: null, at: T0 }], []);
    expect(d).toMatchObject({ accept: false, code: 'capability_not_requested' });
    expect((d as { error: string }).error).toContain('request_capability { provider: "axiom", access: "read" }');
  });
});
