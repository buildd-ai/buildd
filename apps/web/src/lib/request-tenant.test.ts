import { describe, it, expect, mock } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import {
  bestPlan,
  normalizePlan,
  tenantSpanAttributes,
  createTenantNoter,
} from './request-tenant';
import { ServerSpanRegistry } from './server-span-registry';

function fakeSpan(traceId: string, kind: SpanKind) {
  const attrs: Record<string, unknown> = {};
  return {
    kind,
    attrs,
    spanContext: () => ({ traceId, spanId: Math.random().toString(16).slice(2), traceFlags: 1 }),
    setAttributes(a: Record<string, unknown>) { Object.assign(attrs, a); return this; },
  };
}

describe('plans', () => {
  it('an unknown plan value reads as free (entitlements does the same)', () => {
    expect(normalizePlan('team')).toBe('team');
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('enterprise-ish')).toBe('free');
    expect(normalizePlan(null)).toBe('free');
  });

  it('a person in several teams gets their best plan, and that team', () => {
    expect(bestPlan([{ teamId: 'a', plan: 'free' }, { teamId: 'b', plan: 'team' }, { teamId: 'c', plan: 'pro' }])).toEqual({ teamId: 'b', plan: 'team' });
    expect(bestPlan([{ teamId: 'a', plan: 'free' }])).toEqual({ teamId: 'a', plan: 'free' });
    expect(bestPlan([])).toBeNull();
  });
});

describe('tenantSpanAttributes', () => {
  it('team id and plan only: no names, no emails', () => {
    expect(tenantSpanAttributes({ teamId: 't1', plan: 'pro' })).toEqual({ 'buildd.team_id': 't1', 'buildd.plan': 'pro' });
  });
});

describe('ServerSpanRegistry', () => {
  it('remembers the SERVER span of a trace until it ends', () => {
    const reg = new ServerSpanRegistry();
    const root = fakeSpan('tr1', SpanKind.SERVER);
    const child = fakeSpan('tr1', SpanKind.INTERNAL);
    reg.onStart(root as any);
    reg.onStart(child as any);
    expect(reg.serverSpanFor('tr1')).toBe(root as any);
    reg.onEnd(child as any);
    expect(reg.serverSpanFor('tr1')).toBe(root as any);
    reg.onEnd(root as any);
    expect(reg.serverSpanFor('tr1')).toBeUndefined();
  });

  it('is bounded: a span that never ends cannot grow it forever', () => {
    const reg = new ServerSpanRegistry(3);
    for (let i = 0; i < 10; i++) reg.onStart(fakeSpan(`t${i}`, SpanKind.SERVER) as any);
    expect(reg.size).toBe(3);
    expect(reg.serverSpanFor('t9')).toBeDefined();
    expect(reg.serverSpanFor('t0')).toBeUndefined();
  });
});

describe('noteRequestTenant', () => {
  it('tags the active span and the trace\'s server span', async () => {
    const reg = new ServerSpanRegistry();
    const root = fakeSpan('tr1', SpanKind.SERVER);
    const active = fakeSpan('tr1', SpanKind.INTERNAL);
    reg.onStart(root as any);
    const note = createTenantNoter({ registry: reg, activeSpan: () => active as any, setPlan: async () => {} });
    note('key:abc', { teamId: 't1', plan: 'free' });
    expect(active.attrs).toEqual({ 'buildd.team_id': 't1', 'buildd.plan': 'free' });
    expect(root.attrs).toEqual({ 'buildd.team_id': 't1', 'buildd.plan': 'free' });
  });

  it('writes the plan for the read limiter, at most once per subject per throttle window', async () => {
    let now = 1_000_000;
    const setPlan = mock(async (_s: string, _p: string, _ttl: number) => {});
    const note = createTenantNoter({ registry: new ServerSpanRegistry(), activeSpan: () => undefined, setPlan, now: () => now });
    note('key:abc', { teamId: 't1', plan: 'free' });
    note('key:abc', { teamId: 't1', plan: 'free' });
    expect(setPlan).toHaveBeenCalledTimes(1);
    expect(setPlan.mock.calls[0][0]).toBe('key:abc');
    expect(setPlan.mock.calls[0][1]).toBe('free');
    // A changed plan is written at once.
    note('key:abc', { teamId: 't1', plan: 'team' });
    expect(setPlan).toHaveBeenCalledTimes(2);
    // After the throttle window, written again (keeps the Redis TTL alive).
    now += 10 * 60_000;
    note('key:abc', { teamId: 't1', plan: 'team' });
    expect(setPlan).toHaveBeenCalledTimes(3);
  });

  it('never throws: a failing Redis write or span is swallowed', async () => {
    const note = createTenantNoter({
      registry: new ServerSpanRegistry(),
      activeSpan: () => { throw new Error('otel'); },
      setPlan: async () => { throw new Error('redis'); },
    });
    note('key:abc', { teamId: 't1', plan: 'free' });
  });
});
