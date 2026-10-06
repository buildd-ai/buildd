import { describe, expect, test } from 'bun:test';
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from '@buildd/dispatch-contract';
import {
  ALARM_BUDGET,
  ATTEMPT_LEASE_MS,
  FAILSAFE_REARM_MS,
  MAX_CONCURRENT_DELIVERIES,
  MIN_RESCHEDULE_MS,
  RECEIPT_FLUSH_AGE_MS,
  RECEIPT_FLUSH_COUNT,
  RECEIPT_RETRY_MS,
  RETENTION_MS,
} from './engine';
import { createAdapters } from './adapters';
import { ScopeEngine } from './engine';
import { createProducerClient } from './producer';
import { SCOPE_KEY, T0, envelope, harness, sqliteStore } from './test-support';

const WEBHOOK = 'buildd:ws:ws-test:webhook';
const WAKE = 'buildd:ws:ws-test:runner-wake';
// A generic side delivery (`also`): an http-typed target. No producer routes one today.
const SIDE = 'buildd:ws:ws-test:http';
// The target type GitHub Actions used, before it was removed. Old queued intents may still name it.
const OLD_GHA = 'buildd:ws:ws-test:github-actions';
const iso = (ms: number) => new Date(ms).toISOString();

describe('publish', () => {
  test('accepts a new id, then reports it duplicate', async () => {
    const h = harness();
    const e = envelope();
    expect(await h.engine.publish(SCOPE_KEY, [e])).toEqual([{ id: e.id, status: 'accepted' }]);
    expect(await h.engine.publish(SCOPE_KEY, [e])).toEqual([{ id: e.id, status: 'duplicate' }]);
    expect(h.intent(e.id)?.state).toBe('queued');
    expect(h.alarm.at).toBe(T0);
  });

  test('collapses on dedupeKey: earliest notBefore, causes appended once, merged receipt', async () => {
    const h = harness();
    const a = envelope({ dedupeKey: 'task:t-1:now', notBefore: iso(T0 + 60_000), labels: { cause: 'created', causes: ['created'] } });
    const b = envelope({ dedupeKey: 'task:t-1:now', notBefore: iso(T0 + 20_000), labels: { cause: 'retried', causes: ['retried', 'created'] } });
    expect(await h.engine.publish(SCOPE_KEY, [a])).toEqual([{ id: a.id, status: 'accepted' }]);
    expect(await h.engine.publish(SCOPE_KEY, [b])).toEqual([{ id: b.id, status: 'merged', into: a.id }]);

    const row = h.intent(a.id)!;
    expect(row.next_due).toBe(T0 + 20_000);
    expect(row.not_before).toBe(T0 + 20_000);
    expect(JSON.parse(row.envelope as string).labels).toEqual({ cause: 'created', causes: ['created', 'retried'] });
    expect(h.intent(b.id)).toMatchObject({ state: 'merged', merged_into: a.id });
    expect(h.pendingReceipts()).toEqual([{ id: b.id, attempt: 0, event: 'merged', into: a.id, at: iso(T0) }]);
    expect(h.alarm.at).toBe(T0 + RECEIPT_FLUSH_AGE_MS); // the merged receipt's flush comes first

    // A re-publish of the merged id is a duplicate, not a second merge.
    expect(await h.engine.publish(SCOPE_KEY, [b])).toEqual([{ id: b.id, status: 'duplicate' }]);
  });

  test('a due-now envelope pulls a scheduled intent forward', async () => {
    const h = harness();
    const a = envelope({ dedupeKey: 'k', notBefore: iso(T0 + 60_000) });
    const b = envelope({ dedupeKey: 'k' });
    await h.engine.publish(SCOPE_KEY, [a, b]);
    expect(h.intent(a.id)).toMatchObject({ next_due: T0, not_before: null });
  });

  test('does not merge into an intent that is no longer queued', async () => {
    const h = harness();
    const a = envelope({ dedupeKey: 'k' });
    await h.engine.publish(SCOPE_KEY, [a]);
    await h.runToAlarm();
    expect(h.intent(a.id)?.state).toBe('delivered');
    const b = envelope({ dedupeKey: 'k' });
    expect(await h.engine.publish(SCOPE_KEY, [b])).toEqual([{ id: b.id, status: 'accepted' }]);
  });
});

describe('alarm loop', () => {
  test('never delivers before notBefore', async () => {
    const h = harness();
    const e = envelope({ notBefore: iso(T0 + 90_000) });
    await h.engine.publish(SCOPE_KEY, [e]);
    expect(h.alarm.at).toBe(T0 + 90_000);

    // A spurious early alarm (at-least-once platform) delivers nothing.
    h.clock.set(T0 + 89_999);
    await h.engine.runAlarm();
    expect(h.producer.relayCalls).toHaveLength(0);
    expect(h.alarm.at).toBe(T0 + 90_000);

    // Even if next_due were wrong, not_before still holds.
    h.store.db.query('UPDATE intents SET next_due = ? WHERE id = ?').run(T0, e.id);
    await h.engine.runAlarm();
    expect(h.producer.relayCalls).toHaveLength(0);

    h.clock.set(T0 + 90_000);
    await h.engine.runAlarm();
    expect(h.producer.relayCalls).toEqual([{ id: e.id, attempt: 1, target: WAKE }]);
    expect(h.intent(e.id)?.state).toBe('delivered');
  });

  test('a declined first step falls through to the next', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'decline', why: 'no_webhook' };
    const e = envelope({ payload: { taskId: 't-1' }, target: { steps: [{ target: WEBHOOK, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.producer.resolveCalls).toEqual([{ id: e.id, attempt: 1, target: WEBHOOK }]);
    expect(h.producer.relayCalls).toEqual([{ id: e.id, attempt: 1, target: WAKE, payload: { taskId: 't-1' } }]);
    expect(h.outbound.calls).toHaveLength(0);
    expect(h.pendingReceipts()).toEqual([{ id: e.id, attempt: 1, event: 'delivered', via: 'relay:pusher', at: iso(T0) }]);
  });

  test('every first step declining closes the intent as skipped:all_declined', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'decline', why: 'no_webhook' };
    h.producer.relayAnswer = { outcome: 'declined', why: 'no_runner' };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.intent(e.id)?.state).toBe('skipped');
    expect(h.pendingReceipts()[0]).toMatchObject({ event: 'delivered', via: 'skipped:all_declined', attempt: 1 });
    expect(h.alarm.at).toBe(T0 + RECEIPT_FLUSH_AGE_MS); // only the receipt flush is left
  });

  test('resolve skip closes with skipped:<why> and sends nothing', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'skip', why: 'held' };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.intent(e.id)?.state).toBe('skipped');
    expect(h.producer.relayCalls).toHaveLength(0);
    expect(h.pendingReceipts()[0]).toMatchObject({ event: 'delivered', via: 'skipped:held' });
  });

  test('an unknown target declines with unknown_target', async () => {
    const h = harness();
    const e = envelope({ target: { steps: [{ target: 'buildd:ws:ws-test:carrier-pigeon', mode: 'first' }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.engine.detail(e.id)?.targets).toMatchObject([
      { target: 'buildd:ws:ws-test:carrier-pigeon', lastOutcome: 'declined', lastDetail: 'unknown_target' },
      { target: WAKE, lastOutcome: 'delivered' },
    ]);
  });

  test('a registered target type wins over the id suffix', async () => {
    const h = harness();
    const odd = 'buildd:ws:ws-test:my-hook';
    h.engine.putTarget(odd, 'runner-wake', {});
    await h.engine.publish(SCOPE_KEY, [envelope({ target: { steps: [{ target: odd, mode: 'first' }] } })]);
    await h.runToAlarm();
    expect(h.producer.relayCalls.map(c => c.target)).toEqual([odd]);
  });

  test('also steps fire on the first attempt only', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'deliver', payload: { p: 1 }, grant: { url: 'https://side.example/x', headers: { Authorization: 'Bearer x' } } };
    h.producer.relayAnswer = new Error('relay_http_503');
    const e = envelope({ target: { steps: [{ target: WAKE, mode: 'first' }, { target: SIDE, mode: 'also' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);

    await h.runToAlarm();
    expect(h.outbound.calls).toHaveLength(1);
    expect(h.producer.resolveCalls).toEqual([{ id: e.id, attempt: 1, target: SIDE }]);

    h.producer.relayAnswer = { outcome: 'delivered', via: 'pusher' };
    await h.runNextDue();
    expect(h.producer.relayCalls.map(c => c.attempt)).toEqual([1, 2]);
    expect(h.outbound.calls).toHaveLength(1);
    expect(h.intent(e.id)?.state).toBe('delivered');
  });

  test('an old intent with a github-actions step: that step declines unknown_target without a resolve, the wake still delivers', async () => {
    const h = harness();
    const e = envelope({ target: { steps: [{ target: OLD_GHA, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }, { target: OLD_GHA, mode: 'also', resolve: true }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.producer.resolveCalls).toEqual([]);
    expect(h.outbound.calls).toHaveLength(0);
    expect(h.producer.relayCalls.map(c => c.target)).toEqual([WAKE]);
    expect(h.intent(e.id)?.state).toBe('delivered');
    expect(h.engine.detail(e.id)?.targets.find(t => t.target === OLD_GHA)).toMatchObject({ lastDetail: 'unknown_target' });
  });

  test('a throw retries on retryDelayMs, then fails after MAX_DELIVERY_ATTEMPTS', async () => {
    const h = harness();
    h.producer.relayAnswer = new Error('relay_http_502');
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    const firedAt: number[] = [];
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      // Skip past receipt-only alarms: count delivery attempts.
      while (h.producer.relayCalls.length === i) {
        await h.runToAlarm();
      }
      firedAt.push(h.clock.now());
    }
    expect(h.producer.relayCalls).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    const gaps = firedAt.slice(1).map((t, i) => t - firedAt[i]!);
    expect(gaps).toEqual(Array.from({ length: MAX_DELIVERY_ATTEMPTS - 1 }, (_, i) => retryDelayMs(i + 1)));
    expect(h.intent(e.id)).toMatchObject({ state: 'failed', attempt: MAX_DELIVERY_ATTEMPTS, last_error: 'relay_http_502' });

    const all = [...h.producer.receipts, ...h.pendingReceipts()].filter(r => r.id === e.id);
    expect(all.filter(r => r.event === 'attempted')).toHaveLength(MAX_DELIVERY_ATTEMPTS - 1);
    expect(all.filter(r => r.event === 'attempted').every(r => r.why === 'relay_http_502')).toBe(true);
    expect(all.filter(r => r.event === 'failed')).toEqual([{ id: e.id, attempt: MAX_DELIVERY_ATTEMPTS, event: 'failed', why: 'relay_http_502', at: expect.any(String) }]);
  });

  test('the attempt is counted when taken, so a delivery that crashes the DO every time ends failed', async () => {
    const h = harness();
    h.producer.relayAnswer = () => new Promise(() => {}); // never settles: the run "dies" in flight
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      void h.engine.runAlarm(); // abandoned, like an evicted DO
      await Bun.sleep(1);
      expect(h.intent(e.id)).toMatchObject({ state: 'attempting', attempt: i });
      h.clock.advance(ATTEMPT_LEASE_MS);
    }
    await h.engine.runAlarm();
    expect(h.producer.relayCalls.map(c => c.attempt)).toEqual(Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, i) => i + 1));
    expect(h.intent(e.id)).toMatchObject({ state: 'failed', attempt: MAX_DELIVERY_ATTEMPTS, last_error: 'lost_in_flight' });
    const all = [...h.producer.receipts, ...h.pendingReceipts()];
    expect(all.filter(r => r.event === 'attempted' && r.why === 'lost_in_flight').map(r => r.attempt))
      .toEqual(Array.from({ length: MAX_DELIVERY_ATTEMPTS - 1 }, (_, i) => i + 1));
    expect(all.filter(r => r.event === 'failed')).toMatchObject([{ attempt: MAX_DELIVERY_ATTEMPTS, why: 'lost_in_flight' }]);
  });

  test('a normal throw counts exactly one attempt', async () => {
    const h = harness();
    h.producer.relayAnswer = new Error('boom');
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runNextDue();
    expect(h.intent(e.id)).toMatchObject({ state: 'queued', attempt: 1 });
    await h.runNextDue();
    expect(h.intent(e.id)).toMatchObject({ state: 'queued', attempt: 2 });
  });

  test('a retry resumes at the step that threw, not at a step that declined', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'decline', why: 'no_webhook' };
    h.producer.relayAnswer = new Error('boom');
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    h.producer.relayAnswer = { outcome: 'delivered', via: 'pusher' };
    while (h.intent(e.id)?.state === 'queued') await h.runToAlarm();
    expect(h.producer.resolveCalls).toHaveLength(1);
    expect(h.intent(e.id)?.state).toBe('delivered');
  });

  test('reschedule re-arms without counting an attempt', async () => {
    const h = harness();
    let answers = 0;
    h.producer.resolveAnswer = () => (answers++ === 0
      ? { decision: 'reschedule', notBefore: iso(T0 + 300_000) }
      : { decision: 'deliver', payload: {}, grant: { url: 'https://hook.example/x', headers: {} } });
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.intent(e.id)).toMatchObject({ state: 'queued', attempt: 0, not_before: T0 + 300_000, next_due: T0 + 300_000 });
    expect(h.alarm.at).toBe(T0 + 300_000);
    expect(h.pendingReceipts()).toEqual([]);

    await h.runToAlarm();
    expect(h.producer.resolveCalls.map(c => c.attempt)).toEqual([1, 1]);
    expect(h.intent(e.id)).toMatchObject({ state: 'delivered', attempt: 1 });
  });

  test('a reschedule into the past is pushed out, so it cannot spin', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'reschedule', notBefore: iso(T0 - 1000) };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.intent(e.id)?.next_due).toBe(T0 + MIN_RESCHEDULE_MS);
  });

  test('expiresAt closes an undelivered intent as expired, on time', async () => {
    const h = harness();
    h.producer.relayAnswer = new Error('down');
    const e = envelope({ expiresAt: iso(T0 + 20_000) });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runNextDue(); // attempt 1 fails, retry would be +15 s
    await h.runNextDue(); // attempt 2 at +15 s fails, retry would be +45 s > expiry
    expect(h.intent(e.id)?.next_due).toBe(T0 + 20_000);
    await h.runNextDue();
    expect(h.intent(e.id)?.state).toBe('expired');
    expect(h.clock.now()).toBe(T0 + 20_000);
    expect(h.producer.relayCalls).toHaveLength(2);
    const all = [...h.producer.receipts, ...h.pendingReceipts()];
    expect(all.find(r => r.event === 'expired')).toMatchObject({ id: e.id, attempt: 2, why: 'expires_at' });
  });

  test('pause holds delivery; resume releases it', async () => {
    const h = harness();
    await h.engine.setPaused(true);
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    expect(h.alarm.at).toBeNull();
    await h.engine.runAlarm();
    expect(h.producer.relayCalls).toHaveLength(0);
    expect(h.engine.counts()).toMatchObject({ paused: true, intents: { queued: 1 } });

    await h.engine.setPaused(false);
    expect(h.alarm.at).toBe(T0);
    await h.runToAlarm();
    expect(h.intent(e.id)?.state).toBe('delivered');
  });

  test('not configured: nothing is delivered and the alarm backs off 60 s', async () => {
    const h = harness();
    h.producer.configured = false;
    await h.engine.publish(SCOPE_KEY, [envelope()]);
    expect(h.alarm.at).toBe(T0 + FAILSAFE_REARM_MS);
    await h.runToAlarm();
    expect(h.producer.relayCalls).toHaveLength(0);
    expect(h.producer.receiptBatches).toHaveLength(0);
    expect(h.alarm.at).toBe(T0 + 2 * FAILSAFE_REARM_MS);
  });

  test('the outermost catch re-arms +60 s', async () => {
    const h = harness();
    await h.engine.publish(SCOPE_KEY, [envelope()]);
    let threw = false;
    const clear = h.alarm.clear.bind(h.alarm);
    const set = h.alarm.set.bind(h.alarm);
    h.alarm.set = (at: number) => {
      if (!threw && at < T0 + FAILSAFE_REARM_MS) { threw = true; throw new Error('storage hiccup'); }
      set(at);
    };
    h.alarm.clear = clear;
    await h.runToAlarm();
    expect(threw).toBe(true);
    expect(h.alarm.at).toBe(T0 + FAILSAFE_REARM_MS);
    expect(h.logs.some(l => l.event === 'dispatch_alarm_error')).toBe(true);
  });

  test(`at most ${MAX_CONCURRENT_DELIVERIES} deliveries in flight, budget ${ALARM_BUDGET} per run`, async () => {
    const h = harness();
    let inFlight = 0;
    let peak = 0;
    h.producer.relayAnswer = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 2));
      inFlight--;
      return { outcome: 'delivered', via: 'pusher' };
    };
    await h.engine.publish(SCOPE_KEY, Array.from({ length: ALARM_BUDGET + 3 }, () => envelope()));
    await h.runToAlarm();
    expect(peak).toBe(MAX_CONCURRENT_DELIVERIES);
    expect(h.producer.relayCalls).toHaveLength(ALARM_BUDGET);
    expect(h.alarm.at).toBe(T0); // the rest are still due
    await h.runToAlarm();
    expect(h.producer.relayCalls).toHaveLength(ALARM_BUDGET + 3);
  });

  test('one structured log line per attempt, without payload', async () => {
    const h = harness();
    const e = envelope({ notBefore: iso(T0 + 1000), payload: { secretish: 'payload-value' } });
    await h.engine.publish(SCOPE_KEY, [e]);
    h.clock.set(T0 + 1500);
    await h.fireAlarm();
    const lines = h.logs.filter(l => l.event === 'dispatch_attempt');
    expect(lines).toEqual([{ event: 'dispatch_attempt', id: e.id, scope: SCOPE_KEY, target: WAKE, outcome: 'delivered', latencyMs: 0, latenessMs: 500 }]);
    expect(JSON.stringify(h.logs)).not.toContain('payload-value');
  });

  test('prunes terminal intents after 14 days', async () => {
    const h = harness();
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    await h.runToAlarm(); // flush
    h.clock.advance(RETENTION_MS + 1);
    await h.engine.runAlarm();
    expect(h.intent(e.id)).toBeNull();
    expect(h.store.db.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  });
});

describe('receipts', () => {
  test('one receipt waits for the 10 s age threshold', async () => {
    const h = harness();
    await h.engine.publish(SCOPE_KEY, [envelope()]);
    await h.runToAlarm();
    expect(h.producer.receiptBatches).toHaveLength(0);
    expect(h.alarm.at).toBe(T0 + RECEIPT_FLUSH_AGE_MS);
    await h.runToAlarm();
    expect(h.producer.receiptBatches).toHaveLength(1);
    expect(h.pendingReceipts()).toEqual([]);
    expect(h.alarm.at).toBeNull();
  });

  test(`${RECEIPT_FLUSH_COUNT} receipts flush at once`, async () => {
    const h = harness();
    await h.engine.publish(SCOPE_KEY, Array.from({ length: RECEIPT_FLUSH_COUNT }, () => envelope()));
    await h.runToAlarm();
    expect(h.producer.receiptBatches.map(b => b.length)).toEqual([RECEIPT_FLUSH_COUNT]);
    expect(h.clock.now()).toBe(T0);
  });

  test('a non-2xx keeps the receipts and retries later', async () => {
    const h = harness();
    h.producer.receiptsOk = false;
    await h.engine.publish(SCOPE_KEY, Array.from({ length: RECEIPT_FLUSH_COUNT }, () => envelope()));
    await h.runToAlarm();
    expect(h.producer.receiptBatches).toHaveLength(1);
    expect(h.pendingReceipts()).toHaveLength(RECEIPT_FLUSH_COUNT);
    expect(h.alarm.at).toBe(T0 + RECEIPT_RETRY_MS);

    h.producer.receiptsOk = true;
    await h.runToAlarm();
    expect(h.producer.receiptBatches).toHaveLength(2);
    expect(h.pendingReceipts()).toEqual([]);
  });
});

describe('receipts against a rate-limiting producer', () => {
  test('a 429 from the receipts callback keeps every receipt queued; the next flush after the retry delay sends them', async () => {
    let now = T0;
    let status = 429;
    const posts: string[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      posts.push(url);
      if (url.endsWith('/receipts')) return new Response(status === 200 ? '{"applied":0}' : '{"error":"rate_limited"}', { status, headers: { 'Retry-After': '1' } });
      return Response.json({ delivered: true, via: 'pusher', outcome: 'delivered' });
    };
    const producer = createProducerClient({ server: 'https://producer.example', ring: { c1: 's' }, fetch: fetchFn, nowSeconds: () => Math.floor(now / 1000) });
    const store = sqliteStore();
    const alarm = { at: null as number | null, set(at: number) { this.at = at; }, clear() { this.at = null; } };
    const engine = new ScopeEngine({ store, now: () => now, alarm, adapters: createAdapters({ fetch: fetchFn, producer, now: () => now }), producer, dryRunTypes: new Set() });
    await engine.publish(SCOPE_KEY, Array.from({ length: RECEIPT_FLUSH_COUNT }, () => envelope()));
    await engine.runAlarm();
    const queued = () => (store.db.query('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n;
    expect(posts.filter(u => u.endsWith('/receipts'))).toHaveLength(1);
    expect(queued()).toBe(RECEIPT_FLUSH_COUNT);
    expect(alarm.at).toBe(T0 + RECEIPT_RETRY_MS);

    status = 200;
    now = alarm.at!;
    await engine.runAlarm();
    expect(queued()).toBe(0);
  });
});

describe('grants and dry-run', () => {
  const SENTINEL = 'grant-sentinel-7f3a9c';

  test('a grant is never written to storage, receipts or logs', async () => {
    const h = harness({ respond: () => new Response(null, { status: 500 }) });
    h.producer.resolveAnswer = {
      decision: 'deliver',
      payload: { dispatchId: 'x' },
      grant: { url: `https://hook.example/run?sig=${SENTINEL}`, headers: { Authorization: `Bearer ${SENTINEL}` } },
    };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();

    expect(h.outbound.calls).toHaveLength(1);
    expect((h.outbound.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SENTINEL}`);
    expect(h.dumpAll()).not.toContain(SENTINEL);
    expect(JSON.stringify(h.logs)).not.toContain(SENTINEL);
    expect(JSON.stringify([...h.producer.receipts, ...h.pendingReceipts()])).not.toContain(SENTINEL);
    expect(JSON.stringify(h.engine.detail(e.id))).not.toContain(SENTINEL);
    expect(h.dumpAll()).toContain('webhook_failed:http_500');
  });

  test('a failed webhook POST falls through to the runner wake in the same attempt, like in-app', async () => {
    const h = harness({ respond: () => new Response(null, { status: 503 }) });
    h.producer.resolveAnswer = { decision: 'deliver', payload: {}, grant: { url: 'https://hook.example/run', headers: {} } };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.intent(e.id)?.state).toBe('delivered');
    expect(h.intent(e.id)?.attempt).toBe(1);
    expect(h.producer.relayCalls).toHaveLength(1);
  });

  test('dry-run types resolve and record the decision without an outbound POST', async () => {
    const h = harness({ dryRun: ['http'] });
    h.producer.resolveAnswer = { decision: 'deliver', payload: {}, grant: { url: 'https://hook.example/x', headers: {} } };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }, { target: SIDE, mode: 'also' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.producer.resolveCalls.map(c => c.target)).toEqual([WEBHOOK, SIDE]);
    expect(h.outbound.calls).toHaveLength(0);
    expect(h.pendingReceipts()).toEqual([{ id: e.id, attempt: 1, event: 'delivered', via: 'dry-run:http:deliver', at: iso(T0) }]);
  });

  test('a dry-run decline still falls through to a real runner wake', async () => {
    const h = harness({ dryRun: ['http'] });
    h.producer.resolveAnswer = { decision: 'decline', why: 'no_webhook' };
    const e = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first' }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    expect(h.producer.relayCalls).toHaveLength(1);
    expect(h.engine.detail(e.id)?.targets[0]).toMatchObject({ target: WEBHOOK, lastDetail: 'dry-run:http:decline:no_webhook' });
  });
});

describe('inspection', () => {
  test('lookup splits known and unknown ids, preserving order', async () => {
    const h = harness();
    const a = envelope({ dedupeKey: 'k' });
    const b = envelope({ dedupeKey: 'k' });
    await h.engine.publish(SCOPE_KEY, [a, b]);
    expect(h.engine.lookup(['nope', b.id, a.id])).toEqual({
      known: [{ id: b.id, state: 'merged', attempt: 0, mergedInto: a.id, closedAt: iso(T0) }, { id: a.id, state: 'queued', attempt: 0 }],
      unknown: ['nope'],
    });
  });

  // The repair floor projects a lost terminal receipt from the lookup, so a
  // terminal summary must say what that receipt said.
  const terminalReceipt = (h: ReturnType<typeof harness>, id: string) =>
    h.pendingReceipts().find(r => r.id === id && r.event !== 'attempted')!;

  test('a delivered intent reports the first step that delivered, not an also step', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'deliver', payload: {}, grant: { url: 'https://side.example/x', headers: {} } };
    const e = envelope({ target: { steps: [{ target: WAKE, mode: 'first' }, { target: SIDE, mode: 'also' }] } });
    await h.engine.publish(SCOPE_KEY, [e]);
    h.clock.advance(5_000);
    await h.runToAlarm();
    const [s] = h.engine.lookup([e.id]).known;
    expect(s).toEqual({ id: e.id, state: 'delivered', attempt: 1, via: 'relay:pusher', closedAt: iso(T0 + 5_000) });
    expect(s!.via).toBe(terminalReceipt(h, e.id).via!);
  });

  test('skipped intents report the receipt via: skipped:<why>, and skipped:all_declined', async () => {
    const h = harness();
    h.producer.resolveAnswer = { decision: 'skip', why: 'held' };
    const skip = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }] } });
    await h.engine.publish(SCOPE_KEY, [skip]);
    await h.runToAlarm();

    h.producer.resolveAnswer = (req) => (req.target === SIDE
      ? { decision: 'deliver', payload: {}, grant: { url: 'https://side.example/x', headers: {} } }
      : { decision: 'decline', why: 'no_webhook' });
    h.producer.relayAnswer = { outcome: 'declined', why: 'no_runner' };
    const none = envelope({ target: { steps: [{ target: WEBHOOK, mode: 'first', resolve: true }, { target: WAKE, mode: 'first' }, { target: SIDE, mode: 'also' }] } });
    await h.engine.publish(SCOPE_KEY, [none]);
    await h.runNextDue();

    const byId = new Map(h.engine.lookup([skip.id, none.id]).known.map(k => [k.id, k]));
    expect(byId.get(skip.id)).toMatchObject({ state: 'skipped', via: 'skipped:held' });
    expect(byId.get(none.id)).toMatchObject({ state: 'skipped', via: 'skipped:all_declined' });
    expect(byId.get(skip.id)!.via).toBe(terminalReceipt(h, skip.id).via!);
    expect(byId.get(none.id)!.via).toBe(terminalReceipt(h, none.id).via!);
  });

  test('failed and expired intents report why; open intents carry no terminal detail', async () => {
    const h = harness();
    h.producer.relayAnswer = new Error('relay_http_502');
    const fail = envelope();
    const late = envelope({ expiresAt: iso(T0 + 1_000), notBefore: iso(T0 + 2_000) });
    const open = envelope({ notBefore: iso(T0 + 6 * 3_600_000) });
    await h.engine.publish(SCOPE_KEY, [fail, late, open]);
    // One run expires `late`; MAX_DELIVERY_ATTEMPTS runs fail `fail`.
    for (let i = 0; i <= MAX_DELIVERY_ATTEMPTS; i++) await h.runNextDue();
    const byId = new Map(h.engine.lookup([fail.id, late.id, open.id]).known.map(k => [k.id, k]));
    expect(byId.get(fail.id)).toMatchObject({ state: 'failed', attempt: MAX_DELIVERY_ATTEMPTS, why: 'relay_http_502', closedAt: expect.any(String) });
    expect(byId.get(late.id)).toMatchObject({ state: 'expired', why: 'expires_at', closedAt: expect.any(String) });
    expect(byId.get(open.id)).toEqual({ id: open.id, state: 'queued', attempt: 0 });
  });

  test('detail shows next due and the last error per target', async () => {
    const h = harness();
    h.producer.relayAnswer = new Error('relay_http_503');
    const e = envelope();
    await h.engine.publish(SCOPE_KEY, [e]);
    await h.runToAlarm();
    const d = h.engine.detail(e.id)!;
    expect(d).toMatchObject({ state: 'queued', attempt: 1, nextDue: iso(T0 + retryDelayMs(1)), lastError: 'relay_http_503' });
    expect(d.targets).toEqual([{ target: WAKE, attempts: 1, lastOutcome: 'error', lastDetail: 'relay_http_503', lastAt: iso(T0) }]);
    expect(h.engine.detail('missing')).toBeNull();
  });
});
