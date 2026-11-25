// The local runner pick and the one relay call (docs/specs/local-runner-provider.md
// §2.3, §4.3, §7): no row when the runner is offline or lacks the model (AC-13),
// a typed outcome on every failure, and never a throw.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  relayHostForRunner,
  setRelayNudge,
  loadLocalRunnerPick,
  pickUsesRelay,
  relayAvailability,
  runRelayJob,
  type LocalRunnerPick,
  type RelayExec,
} from '../model-relay';

const dialect = new PgDialect();
const TEAM = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-14T12:00:00.000Z');

const advert = {
  server: { kind: 'ollama', version: '0.5.0', reachable: true, checkedAt: '2026-11-14T11:59:00.000Z' },
  models: [
    { name: 'nomic-embed-text', capabilities: ['embedding'], dimensions: 768 },
    { name: 'llama3.1:8b', capabilities: ['completion'] },
  ],
};

function exec(answers: Record<string, Record<string, unknown>[]>): { run: RelayExec; tags: string[] } {
  const tags: string[] = [];
  const run: RelayExec = async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql;
    const tag = /^-- (relay:\w+)/.exec(text)?.[1] ?? 'untagged';
    tags.push(tag);
    return { rows: answers[tag] ?? [] };
  };
  return { run, tags };
}

const pick = (over: Partial<LocalRunnerPick> = {}): LocalRunnerPick => ({
  teamId: TEAM, runnerId: RUNNER, chatModel: 'llama3.1:8b', embeddingModel: 'nomic-embed-text', chatAssigned: true,
  runner: { id: RUNNER, accountId: 'acc-1', lastHeartbeatAt: new Date(NOW - 30_000), presenceConnected: true, localModels: advert as any },
  ...over,
});

describe('loadLocalRunnerPick', () => {
  it('reads the three places a pick is stored and the runner through the team join', async () => {
    const e = exec({
      'relay:pick_team': [{ local_runner: { runnerId: RUNNER, chatModel: 'llama3.1:8b' }, embedding_provider: 'local_runner', embedding_model: 'nomic-embed-text', provider_assignments: { chat: 'local_runner' } }],
      'relay:pick_runner': [{ id: RUNNER, account_id: 'acc-1', last_heartbeat_at: new Date(NOW), presence_connected: true, local_models: advert }],
    });
    const p = await loadLocalRunnerPick(TEAM, e.run);
    expect(p).toMatchObject({ runnerId: RUNNER, chatModel: 'llama3.1:8b', embeddingModel: 'nomic-embed-text', chatAssigned: true });
    expect(p!.runner!.localModels!.models.map(m => m.name)).toEqual(['nomic-embed-text', 'llama3.1:8b']);
    expect(pickUsesRelay(p)).toBe(true);
  });

  it('a runner of another team reads as no runner; a hosted embedding pick is not a relay pick', async () => {
    const e = exec({
      'relay:pick_team': [{ local_runner: JSON.stringify({ runnerId: RUNNER, chatModel: null }), embedding_provider: 'openai', embedding_model: 'text-embedding-3-large', provider_assignments: null }],
      'relay:pick_runner': [],
    });
    const p = await loadLocalRunnerPick(TEAM, e.run);
    expect(p).toMatchObject({ runnerId: RUNNER, runner: null, embeddingModel: null, chatAssigned: false });
    expect(pickUsesRelay(p)).toBe(false);
  });

  it('no stored runner costs no second query', async () => {
    const e = exec({ 'relay:pick_team': [{ local_runner: null, embedding_provider: null, embedding_model: null, provider_assignments: null }] });
    expect((await loadLocalRunnerPick(TEAM, e.run))!.runnerId).toBeNull();
    expect(e.tags).toEqual(['relay:pick_team']);
  });
});

describe('relayAvailability', () => {
  it('online and advertised: ok, with the advert line (its dimensions)', () => {
    const a = relayAvailability(pick(), 'nomic-embed-text', 'embedding', NOW);
    expect(a.ok && a.model.dimensions).toBe(768);
  });

  it('offline by the runner-list predicate: runner_offline naming the runner', () => {
    const a = relayAvailability(pick({ runner: { ...pick().runner!, presenceConnected: false } }), 'nomic-embed-text', 'embedding', NOW);
    expect(a).toMatchObject({ ok: false, code: 'runner_offline', runnerId: RUNNER });
  });

  it('a gone runner, no pick and no team are all runner_offline', () => {
    expect(relayAvailability(pick({ runner: null }), 'x', 'embedding', NOW)).toMatchObject({ ok: false, code: 'runner_offline' });
    expect(relayAvailability(pick({ runnerId: null, runner: null }), 'x', 'embedding', NOW)).toMatchObject({ ok: false, code: 'runner_offline' });
    expect(relayAvailability(null, 'x', 'embedding', NOW)).toMatchObject({ ok: false, code: 'runner_offline', runnerId: null });
  });

  it('a model the advert lacks, or lists without the capability: model_missing', () => {
    expect(relayAvailability(pick(), 'mxbai-embed-large', 'embedding', NOW)).toMatchObject({ ok: false, code: 'model_missing' });
    expect(relayAvailability(pick(), 'nomic-embed-text', 'completion', NOW)).toMatchObject({ ok: false, code: 'model_missing' });
  });
});

describe('runRelayJob', () => {
  const input = { teamId: TEAM, kind: 'embed' as const, surface: 'query' as const, namespace: 'ws:memory', model: 'nomic-embed-text', payload: { inputs: ['q'], inputType: 'query' as const, dimensions: 768 } };

  it('AC-13: an offline runner writes no row and answers before any wait', async () => {
    let enqueued = 0;
    let waited = 0;
    const out = await runRelayJob(input, {
      loadPick: async () => pick({ runner: { ...pick().runner!, lastHeartbeatAt: new Date(NOW - 24 * 3_600_000), presenceConnected: null } }),
      enqueue: (async () => { enqueued++; return { ok: true, id: 'j', deadlineAt: new Date() }; }) as any,
      wait: (async () => { waited++; return { ok: true, result: {} }; }) as any,
      now: () => NOW,
    });
    expect(out).toMatchObject({ ok: false, code: 'runner_offline', runnerId: RUNNER });
    expect([enqueued, waited]).toEqual([0, 0]);
  });

  it('online: enqueues for the pinned runner, nudges its account, returns the waited result', async () => {
    const seen: any[] = [];
    const nudged: any[] = [];
    const result = { vectors: [[0.1]], dimensions: 768, model: 'nomic-embed-text' };
    const out = await runRelayJob(input, {
      loadPick: async () => pick(),
      enqueue: (async (job: any) => { seen.push(job); return { ok: true, id: 'job-1', deadlineAt: new Date(NOW + 20_000) }; }) as any,
      wait: (async () => ({ ok: true, result })) as any,
      nudge: (runner, job) => { nudged.push({ runner, job }); },
      now: () => NOW,
    });
    expect(out).toEqual({ ok: true, result, runnerId: RUNNER } as any);
    expect(seen[0]).toMatchObject({ teamId: TEAM, runnerId: RUNNER, kind: 'embed', surface: 'query', model: 'nomic-embed-text' });
    expect(nudged).toEqual([{ runner: { accountId: 'acc-1', runnerId: RUNNER }, job: { id: 'job-1', kind: 'embed' } }]);
  });

  it('a failed nudge does not fail the job; a relay error keeps its code', async () => {
    const out = await runRelayJob(input, {
      loadPick: async () => pick(),
      enqueue: (async () => ({ ok: true, id: 'job-1', deadlineAt: new Date(NOW + 1) })) as any,
      wait: (async () => ({ ok: false, code: 'ollama_error', message: 'model runner crashed' })) as any,
      nudge: () => { throw new Error('pusher down'); },
      now: () => NOW,
    });
    expect(out).toMatchObject({ ok: false, code: 'ollama_error', message: 'model runner crashed' });
  });

  it('never throws: a database error is runner_offline', async () => {
    const out = await runRelayJob(input, { loadPick: async () => { throw new Error('connection refused'); } });
    expect(out).toMatchObject({ ok: false, code: 'runner_offline', message: 'connection refused' });
  });

  it('an oversize chat payload is payload_too_large', async () => {
    const out = await runRelayJob({ ...input, kind: 'chat', surface: 'chat', model: 'llama3.1:8b', payload: { messages: [] } }, {
      loadPick: async () => pick(),
      enqueue: (async () => ({ ok: false, code: 'payload_too_large', message: 'too big' })) as any,
      now: () => NOW,
    });
    expect(out).toMatchObject({ ok: false, code: 'payload_too_large' });
  });
});

describe('relayHostForRunner', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: RUNNER, team_id: TEAM, local_runner: { runnerId: RUNNER, chatModel: null }, embedding_provider: 'local_runner', embedding_model: 'nomic-embed-text', provider_assignments: null, ...over,
  });

  it('the pinned runner of a team that embeds on it is the host', async () => {
    expect(await relayHostForRunner('acc-1', 'http://localhost:8766', exec({ 'relay:host': [row()] }).run)).toEqual({ heartbeatId: RUNNER, host: true });
  });

  it('another runner pinned, or a pick that routes nothing to the relay, is not the host', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    expect(await relayHostForRunner('acc-1', 'u', exec({ 'relay:host': [row({ local_runner: { runnerId: other, chatModel: null } })] }).run)).toEqual({ heartbeatId: RUNNER, host: false });
    expect(await relayHostForRunner('acc-1', 'u', exec({ 'relay:host': [row({ embedding_provider: 'voyage', embedding_model: null })] }).run)).toEqual({ heartbeatId: RUNNER, host: false });
  });

  it('no heartbeat row yet: null', async () => {
    expect(await relayHostForRunner('acc-1', 'u', exec({}).run)).toBeNull();
  });
});

describe('the registered nudge', () => {
  it('is used when a caller passes none, and cleared by null', async () => {
    const nudged: string[] = [];
    setRelayNudge((_runner, job) => { nudged.push(job.id); });
    const deps = {
      loadPick: async () => pick(),
      enqueue: (async () => ({ ok: true, id: 'job-9', deadlineAt: new Date(NOW + 1) })) as any,
      wait: (async () => ({ ok: true, result: {} })) as any,
      now: () => NOW,
    };
    const input = { teamId: TEAM, kind: 'chat' as const, surface: 'chat' as const, model: 'llama3.1:8b', payload: { messages: [] } };
    await runRelayJob(input, deps);
    setRelayNudge(null);
    await runRelayJob(input, deps);
    expect(nudged).toEqual(['job-9']);
  });
});
