// Test harness: a ScopeEngine over bun:sqlite with a fake clock, a recording
// alarm, a scripted producer and a recording fetch. Not part of the Worker
// bundle (excluded from tsconfig; only *.test.ts import it).

import { Database } from 'bun:sqlite';
import type {
  DispatchEnvelope,
  Receipt,
  RelayRequest,
  RelayResponse,
  ResolveRequest,
  ResolveResponse,
} from '@buildd/dispatch-contract';
import { createAdapters, type TargetType } from './adapters';
import { ScopeEngine, type SqlValue, type Store } from './engine';
import type { ProducerClient } from './producer';

export const T0 = Date.parse('2026-10-01T12:00:00.000Z');

export function sqliteStore(db = new Database(':memory:')): Store & { db: Database } {
  return {
    db,
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        // Eager, like the DO API: a statement runs whether or not anyone reads the rows.
        const rows = db.query(query).all(...(bindings as never[])) as Record<string, SqlValue>[];
        return { toArray: () => rows };
      },
    },
    transaction: <T>(fn: () => T) => db.transaction(fn)() as T,
  };
}

type Answer<Req, Res> = Res | Error | ((req: Req) => Res | Error | Promise<Res | Error>);

export class FakeProducer implements ProducerClient {
  configured = true;
  resolveCalls: ResolveRequest[] = [];
  relayCalls: RelayRequest[] = [];
  receiptBatches: Receipt[][] = [];
  resolveAnswer: Answer<ResolveRequest, ResolveResponse> = { decision: 'deliver', payload: {} };
  relayAnswer: Answer<RelayRequest, RelayResponse> = { outcome: 'delivered', via: 'pusher' };
  receiptsOk = true;

  private static async answer<Req, Res>(a: Answer<Req, Res>, req: Req): Promise<Res> {
    const v = typeof a === 'function' ? await (a as (r: Req) => Res | Error | Promise<Res | Error>)(req) : a;
    if (v instanceof Error) throw v;
    return v;
  }
  async resolve(req: ResolveRequest) { this.resolveCalls.push(req); return FakeProducer.answer(this.resolveAnswer, req); }
  async relay(req: RelayRequest) { this.relayCalls.push(req); return FakeProducer.answer(this.relayAnswer, req); }
  async sendReceipts(r: Receipt[]) { this.receiptBatches.push(r); return this.receiptsOk; }
  get receipts(): Receipt[] { return this.receiptBatches.flat(); }
}

export interface FetchCall { url: string; init: RequestInit }

export function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

export function harness(opts: { dryRun?: TargetType[]; respond?: (call: FetchCall) => Response | Promise<Response> } = {}) {
  let now = T0;
  const clock = { now: () => now, set: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; } };
  const store = sqliteStore();
  const producer = new FakeProducer();
  const outbound = recordingFetch(opts.respond);
  const alarm = { at: null as number | null, set(at: number) { this.at = at; }, clear() { this.at = null; } };
  const logs: Record<string, unknown>[] = [];
  const engine = new ScopeEngine({
    store,
    now: clock.now,
    alarm,
    adapters: createAdapters({ fetch: outbound.fn, producer, now: clock.now }),
    producer,
    dryRunTypes: new Set(opts.dryRun ?? []),
    log: line => logs.push(line),
  });
  /** Fire the alarm the way the platform would: only if armed and due. */
  async function fireAlarm(): Promise<boolean> {
    if (alarm.at === null || alarm.at > now) return false;
    alarm.at = null;
    await engine.runAlarm();
    return true;
  }
  /** Jump to the armed alarm time and fire it. */
  async function runToAlarm(): Promise<void> {
    if (alarm.at === null) throw new Error('no alarm armed');
    if (alarm.at > now) now = alarm.at;
    await fireAlarm();
  }
  /** Jump to the earliest due intent (ignoring receipt-only alarms) and run the alarm handler. */
  async function runNextDue(): Promise<void> {
    const r = store.db.query(`SELECT MIN(next_due) AS due FROM intents WHERE state IN ('queued', 'attempting')`).get() as { due: number | null };
    if (r.due === null) throw new Error('nothing due');
    if (r.due > now) now = r.due;
    alarm.at = null;
    await engine.runAlarm();
  }
  function intent(id: string) {
    return store.db.query('SELECT * FROM intents WHERE id = ?').get(id) as Record<string, unknown> | null;
  }
  function dumpAll(): string {
    const tables = store.db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    return JSON.stringify(tables.map(t => store.db.query(`SELECT * FROM "${t.name}"`).all()));
  }
  function pendingReceipts(): Receipt[] {
    return (store.db.query('SELECT body FROM receipts ORDER BY seq').all() as { body: string }[]).map(r => JSON.parse(r.body));
  }
  return { engine, clock, store, producer, outbound, alarm, logs, fireAlarm, runToAlarm, runNextDue, intent, dumpAll, pendingReceipts };
}

export const SCOPE_KEY = 'buildd:workspace:ws-test';

let seq = 0;
export function envelope(over: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  seq++;
  return {
    id: `intent-${seq}`,
    kind: 'work_execution',
    source: { system: 'buildd', scope: 'workspace:ws-test', subject: 'task:t-1' },
    target: { steps: [{ target: 'buildd:ws:ws-test:runner-wake', mode: 'first' }] },
    attempt: 0,
    ...over,
  };
}
