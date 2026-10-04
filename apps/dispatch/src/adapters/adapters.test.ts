import { describe, expect, test } from 'bun:test';
import { envelope, FakeProducer, recordingFetch, T0 } from '../test-support';
import { createAdapters, targetTypeFromId, type DeliveryContext } from '.';

const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({ id: 'i-1', attempt: 1, target: 'buildd:ws:w:webhook', envelope: envelope(), options: {}, ...over });
const step = { target: 'buildd:ws:w:webhook', mode: 'first' as const };
const grant = (over = {}) => ({ decision: 'deliver' as const, payload: { dispatchId: 'i-1' }, grant: { url: 'https://hook.example/run', headers: { Authorization: 'Bearer t' }, ...over } });

describe('target types', () => {
  test.each([
    ['buildd:ws:w:webhook', 'http'],
    ['buildd:ws:w:github-actions', 'github-repository-dispatch'],
    ['buildd:ws:w:runner-wake', 'runner-wake'],
    ['buildd:ws:w:constructor', null],
    ['buildd:ws:w:slack', null],
  ])('%s -> %s', (id, type) => expect(targetTypeFromId(id)).toBe(type as never));
});

describe('http adapter', () => {
  test('POSTs the payload to the grant with its headers', async () => {
    const f = recordingFetch(() => new Response(null, { status: 202 }));
    const a = createAdapters({ fetch: f.fn, producer: new FakeProducer() }).http!;
    expect(await a.deliver(ctx(), step, grant())).toEqual({ kind: 'delivered', via: 'webhook' });
    expect(f.calls[0]!.url).toBe('https://hook.example/run');
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ dispatchId: 'i-1' }));
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  test('non-2xx, a redirect, a timeout and an expired grant decline (fall through, like in-app) without the URL', async () => {
    for (const [respond, msg] of [
      [() => new Response(null, { status: 500 }), 'http_500'],
      [() => new Response(null, { status: 302 }), 'http_302'],
      [() => { const e = new Error('slow https://hook.example/run'); e.name = 'TimeoutError'; throw e; }, 'timeout'],
      [() => { throw new Error('connect failed https://hook.example/run'); }, 'network_error'],
    ] as const) {
      const a = createAdapters({ fetch: recordingFetch(respond).fn, producer: new FakeProducer() }).http!;
      expect(await a.deliver(ctx(), step, grant())).toEqual({ kind: 'declined', why: `webhook_failed:${msg}` });
    }
    const a = createAdapters({ fetch: recordingFetch().fn, producer: new FakeProducer(), now: () => T0 }).http!;
    expect(await a.deliver(ctx(), step, grant({ expiresAt: new Date(T0 - 1).toISOString() }))).toEqual({ kind: 'declined', why: 'webhook_failed:grant_expired' });
  });

  test('no grant declines', async () => {
    const f = recordingFetch();
    const a = createAdapters({ fetch: f.fn, producer: new FakeProducer() }).http!;
    expect(await a.deliver(ctx(), step, { decision: 'deliver', payload: {} })).toEqual({ kind: 'declined', why: 'no_grant' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('runner-wake adapter', () => {
  test('relays with the inline payload and maps outcomes', async () => {
    const p = new FakeProducer();
    const a = createAdapters({ fetch: recordingFetch().fn, producer: p })['runner-wake']!;
    const c = ctx({ target: 'buildd:ws:w:runner-wake', envelope: envelope({ payload: { taskId: 't' } }) });
    expect(await a.deliver(c, step)).toEqual({ kind: 'delivered', via: 'relay:pusher' });
    expect(p.relayCalls).toEqual([{ id: 'i-1', attempt: 1, target: 'buildd:ws:w:runner-wake', payload: { taskId: 't' } }]);
    p.relayAnswer = { outcome: 'skipped', why: 'no_runner' };
    expect(await a.deliver(c, step)).toEqual({ kind: 'skipped', why: 'no_runner' });
  });
});
