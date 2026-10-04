/**
 * ScopeQueue: one SQLite Durable Object per scope key
 * (`idFromName(`${source.system}:${source.scope}`)`). A thin shell: storage,
 * alarm, clock, fetch and secrets are wired into ScopeEngine (engine.ts),
 * which holds all the behaviour and is what the tests cover.
 */
import { DurableObject } from 'cloudflare:workers';
import { parseKeyRing, type DispatchEnvelope } from '@buildd/dispatch-contract';
import { createAdapters, type TargetOptions, type TargetType } from './adapters';
import { parseDryRunTypes } from './config';
import { ScopeEngine, type SqlValue, type Store } from './engine';
import type { Env } from './env';
import { createProducerClient } from './producer';

export class ScopeQueue extends DurableObject<Env> {
  private readonly engine: ScopeEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store: Store = {
      sql: { exec: (query: string, ...bindings: SqlValue[]) => ctx.storage.sql.exec(query, ...bindings) },
      transaction: fn => ctx.storage.transactionSync(fn),
    };
    const outbound = (input: string, init: RequestInit) => fetch(input, init);
    const producer = createProducerClient({ server: env.BUILDD_SERVER, ring: parseKeyRing(env.CALLBACK_SECRET), fetch: outbound });
    this.engine = new ScopeEngine({
      store,
      now: () => Date.now(),
      alarm: { set: at => ctx.storage.setAlarm(at), clear: () => ctx.storage.deleteAlarm() },
      adapters: createAdapters({ fetch: outbound, producer }),
      producer,
      dryRunTypes: parseDryRunTypes(env.DRY_RUN_TYPES),
    });
  }

  publish(scopeKey: string, envelopes: DispatchEnvelope[]) { return this.engine.publish(scopeKey, envelopes); }
  lookup(ids: string[]) { return this.engine.lookup(ids); }
  detail(id: string) { return this.engine.detail(id); }
  counts() { return this.engine.counts(); }
  setPaused(paused: boolean) { return this.engine.setPaused(paused); }
  putTarget(id: string, type: TargetType, options: TargetOptions) { return this.engine.putTarget(id, type, options); }

  async alarm(): Promise<void> {
    await this.engine.runAlarm();
  }
}
