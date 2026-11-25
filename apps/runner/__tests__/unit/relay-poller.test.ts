/**
 * RelayPoller (docs/specs/local-runner-provider.md §6.3, §6.4, M9, M10):
 * claims relay jobs for the pinned runner, runs them against a fake loopback
 * model server and posts results, errors and throughput.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { RelayClaimedJob, RelayClaimRequest, RelayClaimResponse, RelayProgressRequest, RelayResultRequest } from '@buildd/shared';
import { LocalModelServer } from '../../src/local-model-server';
import { RelayPoller, RelayStatsWindow, createRelayPoller, type RelayApi } from '../../src/relay-poller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const servers: Array<{ stop: (force?: boolean) => void }> = [];
const pollers: RelayPoller[] = [];

afterEach(() => {
  for (const p of pollers.splice(0)) p.stop();
  for (const s of servers.splice(0)) s.stop(true);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeModelOpts {
  embedDims?: number;
  embedStatus?: number;
  embedDelayMs?: number;
  chatChunks?: string[];
  chatChunkDelayMs?: number;
  models?: string[];
}

/** A fake Ollama on loopback: tags, show, /v1/embeddings and /v1/chat/completions. */
function fakeModelServer(opts: FakeModelOpts = {}) {
  const calls: string[] = [];
  const state = { models: opts.models ?? ['nomic-embed-text', 'llama3.2'] };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/api/version') return json({ version: '0.12.3' });
      if (url.pathname === '/api/tags') return json({ models: state.models.map(name => ({ name })) });
      if (url.pathname === '/api/show') {
        const { model } = await req.json() as { model: string };
        return model.includes('embed')
          ? json({ capabilities: ['embedding'], model_info: { 'bert.embedding_length': 768 } })
          : json({ capabilities: ['completion'], model_info: {} });
      }
      if (url.pathname === '/v1/embeddings') {
        const body = await req.json() as { model: string; input: string[] };
        if (opts.embedDelayMs) await new Promise(r => setTimeout(r, opts.embedDelayMs));
        if (opts.embedStatus) return json({ error: { message: 'boom' } }, opts.embedStatus);
        if (!state.models.includes(body.model)) return json({ error: { message: `model "${body.model}" not found` } }, 404);
        return json({ data: body.input.map((_, index) => ({ index, embedding: Array(opts.embedDims ?? 768).fill(0.5) })), usage: { prompt_tokens: 3 * body.input.length } });
      }
      if (url.pathname === '/v1/chat/completions') {
        const enc = new TextEncoder();
        const chunks = opts.chatChunks ?? ['Hi', ' there'];
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const content of chunks) {
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
              if (opts.chatChunkDelayMs) await new Promise(r => setTimeout(r, opts.chatChunkDelayMs));
            }
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: chunks.length } })}\n\ndata: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return json({ error: 'not found' }, 404);
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, calls, state };
}

let leaseSeq = 0;
function embedJob(over: Partial<RelayClaimedJob> = {}, inputs = ['one', 'two'], dimensions = 768): RelayClaimedJob {
  const n = ++leaseSeq;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'embed', model: 'nomic-embed-text',
    payload: { inputs, inputType: 'document', dimensions },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), leaseId: `lease-${n}`,
    ...over,
  };
}
function chatJob(over: Partial<RelayClaimedJob> = {}): RelayClaimedJob {
  return embedJob({ kind: 'chat', model: 'llama3.2', payload: { messages: [{ role: 'user', content: 'hello' }], options: { temperature: 0 } }, ...over });
}

/** The buildd relay routes, in memory: hands out queued jobs once, records every post. */
function fakeApi(queue: RelayClaimedJob[][] = [], opts: { pollAfterMs?: number; progress?: 'ok' | 'stop' } = {}) {
  const claims: RelayClaimRequest[] = [];
  const results: Array<{ jobId: string; body: RelayResultRequest }> = [];
  const progress: Array<{ jobId: string; body: RelayProgressRequest }> = [];
  const api: RelayApi = {
    async claim(body) {
      claims.push(body);
      return { jobs: queue.shift() ?? [], pollAfterMs: opts.pollAfterMs ?? 15_000 } satisfies RelayClaimResponse;
    },
    async result(jobId, body) {
      results.push({ jobId, body });
      return { status: 'done' };
    },
    async progress(jobId, body) {
      progress.push({ jobId, body });
      return opts.progress ?? 'ok';
    },
  };
  return { api, claims, results, progress, queue };
}

async function setup(opts: { model?: FakeModelOpts; queue?: RelayClaimedJob[][]; api?: Parameters<typeof fakeApi>[1]; held?: () => boolean; enabled?: boolean; host?: boolean; poller?: Partial<ConstructorParameters<typeof RelayPoller>[0]> } = {}) {
  const model = fakeModelServer(opts.model);
  const server = new LocalModelServer({ origin: model.origin });
  const remote = fakeApi(opts.queue ?? [], opts.api);
  const beats: number[] = [];
  const poller = new RelayPoller({
    api: remote.api, server, held: opts.held ?? (() => false), enabled: opts.enabled,
    onAdvertChanged: () => { beats.push(Date.now()); },
    log: () => {},
    ...opts.poller,
  });
  pollers.push(poller);
  await poller.refreshAdvert();
  if (opts.host !== false) poller.noteHeartbeat({ heartbeatId: RUNNER_ID, relay: { host: true, pollAfterMs: 60_000 } });
  return { poller, model, server, beats, ...remote };
}

describe('RelayPoller: advert', () => {
  it('advertises the detected models and asks for a heartbeat when they change', async () => {
    const s = await setup({ host: false });
    expect(s.beats.length).toBe(1);
    const advert = s.poller.advert()!;
    expect(advert.models.map(m => m.name)).toEqual(['nomic-embed-text', 'llama3.2']);
    expect(advert.relayStats).toEqual({ jobs: 0, errors: 0, p50DurationMs: null, p95DurationMs: null, lastErrorCode: null, lastErrorAt: null });

    await s.poller.refreshAdvert();
    expect(s.beats.length).toBe(1);
    s.model.state.models = ['llama3.2'];
    await s.poller.refreshAdvert();
    expect(s.beats.length).toBe(2);
  });

  it('opted out: advertises nothing, probes nothing and never claims (AC-20)', async () => {
    const s = await setup({ enabled: false, queue: [[embedJob()]] });
    expect(s.poller.advert()).toBeNull();
    expect(s.model.calls).toEqual([]);
    expect(await s.poller.tick()).toBe(0);
    s.poller.nudge();
    await new Promise(r => setTimeout(r, 20));
    expect(s.claims).toEqual([]);

    const off = createRelayPoller({ builddServer: 'http://127.0.0.1:9', apiKey: 'bld_x', env: { BUILDD_LOCAL_MODEL_RELAY: '0' }, held: () => false });
    expect(off.advert()).toBeNull();
    expect(await off.tick()).toBe(0);
  });
});

describe('RelayPoller: claiming', () => {
  it('does not claim until the heartbeat says this runner is the relay host (AC-21)', async () => {
    const s = await setup({ host: false, queue: [[embedJob()]] });
    expect(await s.poller.tick()).toBe(0);
    s.poller.noteHeartbeat({ heartbeatId: RUNNER_ID, relay: { host: false, pollAfterMs: 0 } });
    expect(await s.poller.tick()).toBe(0);
    expect(s.claims).toEqual([]);
  });

  it('claims within pollAfterMs once it is the host, naming its runner id and served models (AC-21)', async () => {
    const s = await setup({ host: false, queue: [[embedJob()]] });
    s.poller.noteHeartbeat({ heartbeatId: RUNNER_ID, relay: { host: true, pollAfterMs: 20 } });
    for (let i = 0; i < 100 && s.results.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(s.claims[0]).toEqual({ runnerId: RUNNER_ID, models: ['nomic-embed-text', 'llama3.2'] });
    expect(s.results.length).toBe(1);
  });

  it('stops polling when the server answers pollAfterMs 0, until a heartbeat pins it again', async () => {
    const s = await setup({ api: { pollAfterMs: 0 } });
    await s.poller.tick();
    expect(s.claims.length).toBe(1);
    await s.poller.tick();
    expect(s.claims.length).toBe(1);
    s.poller.noteHeartbeat({ heartbeatId: RUNNER_ID, relay: { host: true, pollAfterMs: 60_000 } });
    await s.poller.tick();
    expect(s.claims.length).toBe(2);
  });

  it('claims nothing while a person holds the runner, and claims once the hold ends (AC-22)', async () => {
    let held = true;
    const s = await setup({ held: () => held, queue: [[embedJob()]] });
    expect(await s.poller.tick()).toBe(0);
    s.poller.nudge();
    await new Promise(r => setTimeout(r, 20));
    expect(s.claims).toEqual([]);
    held = false;
    expect(await s.poller.tick()).toBe(1);
  });

  it('claims at once on a nudge for this runner and ignores one for another runner', async () => {
    const s = await setup({ queue: [[embedJob()]] });
    s.poller.nudge({ runnerId: '22222222-2222-4222-8222-222222222222' });
    await new Promise(r => setTimeout(r, 20));
    expect(s.claims).toEqual([]);
    s.poller.nudge({ runnerId: RUNNER_ID });
    for (let i = 0; i < 100 && s.results.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(s.results.length).toBe(1);
  });

  it('keeps claiming until the queue is empty, one model call at a time', async () => {
    const s = await setup({ queue: [[embedJob(), embedJob()], [embedJob()]], model: { embedDelayMs: 15 } });
    expect(await s.poller.tick()).toBe(3);
    expect(s.claims.length).toBe(3);
    expect(s.results.map(r => r.body.ok)).toEqual([true, true, true]);
  });

  it('runs a chat job before the embed batches it was claimed with', async () => {
    const embed = embedJob();
    const chat = chatJob();
    const s = await setup({ queue: [[embed, chat]] });
    await s.poller.tick();
    expect(s.results.map(r => r.jobId)).toEqual([chat.id, embed.id]);
  });
});

describe('RelayPoller: embed', () => {
  it('posts the vectors, their size, the model, tokens and duration', async () => {
    const job = embedJob();
    const s = await setup({ queue: [[job]] });
    await s.poller.tick();
    expect(s.model.calls).toContain('POST /v1/embeddings');
    const { jobId, body } = s.results[0];
    expect(jobId).toBe(job.id);
    expect(body).toMatchObject({ runnerId: RUNNER_ID, leaseId: job.leaseId, ok: true, result: { dimensions: 768, model: 'nomic-embed-text', promptTokens: 6 } });
    const result = (body as any).result;
    expect(result.vectors.length).toBe(2);
    expect(result.vectors[0].length).toBe(768);
    expect(typeof result.durationMs).toBe('number');
  });

  it('refuses a vector of another size with dimension_mismatch and nothing else (AC-23)', async () => {
    const s = await setup({ queue: [[embedJob()]], model: { embedDims: 1024 } });
    await s.poller.tick();
    expect(s.results.length).toBe(1);
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'dimension_mismatch' } });
    expect((s.results[0].body as any).result).toBeUndefined();
  });

  it('reports an upstream failure with its HTTP status so the server can retry it', async () => {
    const s = await setup({ queue: [[embedJob()]], model: { embedStatus: 503 } });
    await s.poller.tick();
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'ollama_error', httpStatus: 503 } });
  });

  it('reports model_missing and probes again so the advert drops the tag', async () => {
    const s = await setup({ queue: [[embedJob()]] });
    s.model.state.models = ['llama3.2'];
    const beats = s.beats.length;
    await s.poller.tick();
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'model_missing' } });
    expect(s.poller.advert()!.models.map(m => m.name)).toEqual(['llama3.2']);
    expect(s.beats.length).toBe(beats + 1);
  });

  it('aborts the model call at the job\'s budget and posts timeout', async () => {
    const job = embedJob({ deadlineAt: new Date(Date.now() + 150).toISOString() });
    const s = await setup({ queue: [[job]], model: { embedDelayMs: 2_000 }, poller: { safetyMarginMs: 50 } });
    const started = Date.now();
    await s.poller.tick();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('posts timeout without calling the model when the deadline has already passed', async () => {
    const s = await setup({ queue: [[embedJob({ deadlineAt: new Date(Date.now() - 1_000).toISOString() })]] });
    await s.poller.tick();
    expect(s.model.calls).not.toContain('POST /v1/embeddings');
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('refuses a payload it cannot read as bad_result', async () => {
    const s = await setup({ queue: [[embedJob({ payload: { inputs: 'nope' } as any })]] });
    await s.poller.tick();
    expect(s.results[0].body).toMatchObject({ ok: false, error: { code: 'bad_result' } });
  });

  it('renews the lease of every job it holds while a slow one runs', async () => {
    const first = embedJob();
    const second = embedJob();
    const s = await setup({ queue: [[first, second]], model: { embedDelayMs: 80 }, poller: { leaseRenewMs: 20 } });
    await s.poller.tick();
    const renewed = new Set(s.progress.map(p => p.jobId));
    expect(renewed.has(first.id)).toBe(true);
    expect(renewed.has(second.id)).toBe(true);
    expect(s.progress.every(p => p.body.partialText === undefined)).toBe(true);
    expect(s.results.length).toBe(2);
  });

  it('drops a job the server says is no longer open: no model call, no result', async () => {
    const first = embedJob();
    const second = embedJob();
    const s = await setup({ queue: [[first, second]], model: { embedDelayMs: 80 }, api: { progress: 'stop' }, poller: { leaseRenewMs: 20 } });
    await s.poller.tick();
    expect(s.results).toEqual([]);
    expect(s.model.calls.filter(c => c === 'POST /v1/embeddings').length).toBe(1);
  });
});

describe('RelayPoller: chat', () => {
  it('posts the full text, finish reason, usage and throughput', async () => {
    const job = chatJob();
    const s = await setup({ queue: [[job]] });
    await s.poller.tick();
    expect(s.model.calls).toContain('POST /v1/chat/completions');
    expect(s.results[0].body).toMatchObject({
      runnerId: RUNNER_ID, leaseId: job.leaseId, ok: true,
      result: { text: 'Hi there', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } },
    });
    expect(typeof (s.results[0].body as any).result.durationMs).toBe('number');
  });

  it('forwards text as it is generated in progress posts whose parts add up to a prefix of the result', async () => {
    const s = await setup({ queue: [[chatJob()]], model: { chatChunks: ['a', 'b', 'c', 'd'], chatChunkDelayMs: 30 }, poller: { progressIntervalMs: 20 } });
    await s.poller.tick();
    const parts = s.progress.map(p => p.body.partialText).filter((t): t is string => !!t);
    expect(parts.length).toBeGreaterThan(1);
    expect('abcd'.startsWith(parts.join(''))).toBe(true);
    expect((s.results[0].body as any).result.text).toBe('abcd');
  });

  it('stops the model call when the server says the job is gone, and posts nothing', async () => {
    const s = await setup({ queue: [[chatJob()]], model: { chatChunks: Array(40).fill('x'), chatChunkDelayMs: 25 }, api: { progress: 'stop' }, poller: { progressIntervalMs: 20 } });
    const started = Date.now();
    await s.poller.tick();
    expect(Date.now() - started).toBeLessThan(800);
    expect(s.results).toEqual([]);
  });
});

describe('RelayPoller: throughput and errors', () => {
  it('reports the last hour of jobs, errors and durations in the advert', async () => {
    const s = await setup({ queue: [[embedJob(), embedJob()], [embedJob({ model: 'gone-embed' })]] });
    await s.poller.tick();
    const stats = s.poller.advert()!.relayStats!;
    expect(stats.jobs).toBe(3);
    expect(stats.errors).toBe(1);
    expect(stats.lastErrorCode).toBe('model_missing');
    expect(typeof stats.p50DurationMs).toBe('number');
    expect(stats.p95DurationMs!).toBeGreaterThanOrEqual(stats.p50DurationMs!);
    expect(Number.isFinite(Date.parse(stats.lastErrorAt!))).toBe(true);
  });

  it('RelayStatsWindow forgets entries older than an hour and computes percentiles', () => {
    let t = 10_000_000;
    const w = new RelayStatsWindow(() => t);
    for (const ms of [10, 20, 30, 40, 100]) w.record(ms, null);
    w.record(500, 'timeout');
    expect(w.snapshot()).toMatchObject({ jobs: 6, errors: 1, p50DurationMs: 30, p95DurationMs: 500, lastErrorCode: 'timeout' });
    t += 61 * 60_000;
    w.record(7, null);
    expect(w.snapshot()).toEqual({ jobs: 1, errors: 0, p50DurationMs: 7, p95DurationMs: 7, lastErrorCode: null, lastErrorAt: null });
  });

  it('survives a claim that throws and tries again on the next tick', async () => {
    const s = await setup({ queue: [[embedJob()]] });
    const claim = s.api.claim;
    let fail = true;
    s.api.claim = async (body) => { if (fail) { fail = false; throw new Error('HTTP 500'); } return claim(body); };
    expect(await s.poller.tick()).toBe(0);
    expect(await s.poller.tick()).toBe(1);
  });
});
