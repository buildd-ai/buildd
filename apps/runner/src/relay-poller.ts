/**
 * The runner's side of the model relay (docs/specs/local-runner-provider.md
 * §4, §6.3, §6.4): when the heartbeat reply says this runner is its team's
 * relay host, claim `embed` and `chat` jobs by outbound poll, run them against
 * the loopback model server and post each result or error back.
 *
 * - Claims on a Pusher nudge and every `pollAfterMs`, whatever the worker
 *   slots are doing: a relay job takes no slot. Nothing is claimed while a
 *   person holds the runner, or when the relay is opted out.
 * - One model call at a time, chat before embed batches. Every job held is
 *   kept leased by progress posts; a chat job's text is forwarded in them as
 *   it is generated.
 * - Each job is stopped at its deadline less a margin and reported `timeout`.
 *   A vector of another size than the job names is `dimension_mismatch`:
 *   never padded, never cut, and no model is ever substituted.
 * - A rolling last hour of counts and durations rides in the heartbeat advert
 *   as `relayStats`. The log line per job carries no payload content.
 *
 * Never throws out of `tick`, `nudge` or `refreshAdvert`.
 */
import {
  RELAY_DEFAULTS,
  isRelayChatPayload,
  isRelayEmbedPayload,
  type LocalModelsAdvert,
  type LocalRelayStats,
  type RelayClaimRequest,
  type RelayClaimResponse,
  type RelayClaimedJob,
  type RelayErrorCode,
  type RelayJobError,
  type RelayJobResult,
  type RelayProgressRequest,
  type RelayResultRequest,
} from '@buildd/shared';
import {
  LOCAL_MODEL_PROBE_INTERVAL_MS,
  LocalModelError,
  LocalModelServer,
  resolveLocalModelServer,
  type LocalChatMessage,
  type LocalChatOptions,
} from './local-model-server';

/** The three relay routes, as the poller uses them. */
export interface RelayApi {
  claim(body: RelayClaimRequest): Promise<RelayClaimResponse>;
  /** `conflict` and `gone`: the job is no longer this runner's; the result was dropped. */
  result(jobId: string, body: RelayResultRequest): Promise<{ status: 'done' | 'failed' | 'requeued' | 'conflict' | 'gone' }>;
  /** `stop`: the lease moved or the job ended; stop the model call. */
  progress(jobId: string, body: RelayProgressRequest): Promise<'ok' | 'stop'>;
}

const STATS_WINDOW_MS = 60 * 60_000;
const STATS_MAX_ENTRIES = 5_000;

/** The last hour of relay jobs, in memory: counts and durations only (spec §6.4). */
export class RelayStatsWindow {
  private entries: Array<{ at: number; durationMs: number; code: RelayErrorCode | null }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(durationMs: number, code: RelayErrorCode | null): void {
    this.entries.push({ at: this.now(), durationMs: Math.max(0, Math.round(durationMs)), code });
    if (this.entries.length > STATS_MAX_ENTRIES) this.entries.splice(0, this.entries.length - STATS_MAX_ENTRIES);
  }

  snapshot(): LocalRelayStats {
    const cutoff = this.now() - STATS_WINDOW_MS;
    this.entries = this.entries.filter(e => e.at >= cutoff);
    const durations = this.entries.map(e => e.durationMs).sort((a, b) => a - b);
    // Nearest rank: the smallest duration at or above the given share of jobs.
    const pct = (p: number) => (durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)]! : null);
    const failed = this.entries.filter(e => e.code !== null);
    const last = failed[failed.length - 1];
    return {
      jobs: this.entries.length,
      errors: failed.length,
      p50DurationMs: pct(0.5),
      p95DurationMs: pct(0.95),
      lastErrorCode: last?.code ?? null,
      lastErrorAt: last ? new Date(last.at).toISOString() : null,
    };
  }
}

export interface RelayPollerDeps {
  api: RelayApi;
  server: LocalModelServer;
  /** True while a person holds the runner (`claimsHeldByPerson`): nothing new starts. */
  held: () => boolean;
  /** False = opted out: nothing is probed, advertised or claimed. */
  enabled?: boolean;
  /** What the server serves changed, or a job failed on a missing model: send a heartbeat. */
  onAdvertChanged?: () => void;
  now?: () => number;
  log?: (line: string) => void;
  /** How often a chat job's new text is posted. */
  progressIntervalMs?: number;
  /** How often every held job's lease is renewed. */
  leaseRenewMs?: number;
  /** Taken off a job's deadline, so the `timeout` post still lands in time. */
  safetyMarginMs?: number;
  probeIntervalMs?: number;
}

interface OpenJob {
  job: RelayClaimedJob;
  abort: AbortController;
  /** The server said the job is no longer ours: no result is posted. */
  dropped: boolean;
}

const PROGRESS_INTERVAL_MS = 500;
const LEASE_RENEW_MS = Math.floor(RELAY_DEFAULTS.leaseMs / 3);
const SAFETY_MARGIN_MS = 2_000;

export class RelayPoller {
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly stats: RelayStatsWindow;
  private runnerId: string | null = null;
  private host = false;
  private pollAfterMs: number = RELAY_DEFAULTS.pollAfterMs;
  private running = false;
  /** A nudge arrived while a claim was in flight: claim once more before stopping. */
  private again = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private readonly open = new Map<string, OpenJob>();

  constructor(private readonly deps: RelayPollerDeps) {
    this.now = deps.now ?? Date.now;
    this.enabled = deps.enabled !== false;
    this.stats = new RelayStatsWindow(this.now);
  }

  /** Probe now and then on an interval. Safe to call when opted out (does nothing). */
  start(): void {
    if (!this.enabled || this.probeTimer) return;
    void this.refreshAdvert();
    this.probeTimer = setInterval(() => { void this.refreshAdvert(); }, this.deps.probeIntervalMs ?? LOCAL_MODEL_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.probeTimer = undefined;
    this.pollTimer = undefined;
    this.host = false;
    for (const o of this.open.values()) o.abort.abort();
  }

  /** Look at the local model server again; asks for a heartbeat when what it serves changed. */
  async refreshAdvert(): Promise<void> {
    if (!this.enabled) return;
    try {
      if (await this.deps.server.probe()) this.deps.onAdvertChanged?.();
    } catch { /* probe never throws; a callback might */ }
  }

  /** The heartbeat's `localModels`: what is served plus the last hour of relay figures. Null = send nothing. */
  advert(): LocalModelsAdvert | null {
    if (!this.enabled) return null;
    const advert = this.deps.server.advert();
    return advert ? { ...advert, relayStats: this.stats.snapshot() } : null;
  }

  /** False when the relay is opted out or this runner kind never hosts. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether this runner is its team's pinned relay host, as the last heartbeat said. */
  isHost(): boolean {
    return this.host;
  }

  /**
   * The heartbeat reply's `heartbeatId` and `relay` block. A reply without
   * them (an older server, a failed lookup) keeps what the last one said.
   */
  noteHeartbeat(reply: { heartbeatId?: string | null; relay?: { host?: boolean; pollAfterMs?: number } | null }): void {
    if (!this.enabled) return;
    if (typeof reply.heartbeatId === 'string' && reply.heartbeatId) this.runnerId = reply.heartbeatId;
    if (!reply.relay) return;
    this.host = reply.relay.host === true;
    const every = reply.relay.pollAfterMs;
    if (this.host && typeof every === 'number' && every > 0) this.pollAfterMs = every;
    this.schedule();
  }

  /** A `relay:job_queued` nudge: claim now. One naming another runner of the account is ignored. */
  nudge(data?: { runnerId?: unknown } | null): void {
    if (typeof data?.runnerId === 'string' && this.runnerId && data.runnerId.toLowerCase() !== this.runnerId.toLowerCase()) return;
    void this.tick();
  }

  private canClaim(): boolean {
    return this.enabled && this.host && !!this.runnerId && !this.deps.held();
  }

  private schedule(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (!this.enabled || !this.host || !this.runnerId) return;
    this.pollTimer = setTimeout(() => { void this.tick(); }, this.pollAfterMs);
    this.pollTimer.unref?.();
  }

  /** Claim and run jobs until the queue is empty. Resolves the number of jobs handled. */
  async tick(): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    if (!this.canClaim()) {
      this.schedule();
      return 0;
    }
    this.running = true;
    let handled = 0;
    try {
      for (;;) {
        this.again = false;
        if (!this.canClaim()) break;
        const models = this.deps.server.modelNames();
        if (models.length === 0) break;
        const claimed = await this.deps.api.claim({ runnerId: this.runnerId!, models });
        if (claimed.pollAfterMs === 0) this.host = false;
        else if (typeof claimed.pollAfterMs === 'number' && claimed.pollAfterMs > 0) this.pollAfterMs = claimed.pollAfterMs;
        const jobs = Array.isArray(claimed.jobs) ? claimed.jobs : [];
        if (jobs.length === 0) {
          if (this.again) continue;
          break;
        }
        handled += await this.runBatch(jobs);
      }
    } catch (err) {
      this.log(`[relay] claim failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
      this.schedule();
    }
    return handled;
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /** Run a claim's jobs one at a time, chat first, renewing every held lease meanwhile. */
  private async runBatch(jobs: RelayClaimedJob[]): Promise<number> {
    const ordered = [...jobs].sort((a, b) => Number(b.kind === 'chat') - Number(a.kind === 'chat'));
    for (const job of ordered) this.open.set(job.id, { job, abort: new AbortController(), dropped: false });
    const renew = setInterval(() => {
      for (const o of this.open.values()) if (!o.dropped) void this.postProgress(o);
    }, this.deps.leaseRenewMs ?? LEASE_RENEW_MS);
    renew.unref?.();
    let handled = 0;
    try {
      for (const job of ordered) {
        const o = this.open.get(job.id)!;
        if (!o.dropped) {
          await this.runJob(o);
          handled++;
        }
        this.open.delete(job.id);
      }
    } finally {
      clearInterval(renew);
      for (const job of ordered) this.open.delete(job.id);
    }
    return handled;
  }

  /** Renew one job's lease, with new chat text if any. A `stop` answer drops the job and stops its model call. */
  private async postProgress(o: OpenJob, partialText?: string): Promise<void> {
    try {
      const answer = await this.deps.api.progress(o.job.id, {
        runnerId: this.runnerId!, leaseId: o.job.leaseId, ...(partialText ? { partialText } : {}),
      });
      if (answer === 'stop') {
        o.dropped = true;
        o.abort.abort();
      }
    } catch { /* a missed renewal is retried on the next interval */ }
  }

  private async runJob(o: OpenJob): Promise<void> {
    const { job } = o;
    const started = this.now();
    let outcome: { ok: true; result: RelayJobResult } | { ok: false; error: RelayJobError };
    const budgetMs = Date.parse(job.deadlineAt) - started - (this.deps.safetyMarginMs ?? SAFETY_MARGIN_MS);
    if (!(budgetMs > 0)) {
      outcome = { ok: false, error: { code: 'timeout', message: 'the job reached this runner too close to its deadline' } };
    } else {
      const budget = setTimeout(() => o.abort.abort(), budgetMs);
      try {
        const result = job.kind === 'chat' ? await this.runChat(o) : await this.runEmbed(o);
        outcome = { ok: true, result: { ...result, durationMs: this.now() - started } };
      } catch (err) {
        const error: RelayJobError = err instanceof LocalModelError
          ? { code: err.code, message: err.message, ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}) }
          : { code: 'ollama_error', message: err instanceof Error ? err.message.slice(0, 300) : 'the local model call failed' };
        if (error.code === 'timeout') error.message = `the local model did not finish within ${budgetMs} ms`;
        outcome = { ok: false, error };
      } finally {
        clearTimeout(budget);
      }
    }
    const durationMs = this.now() - started;
    if (o.dropped) {
      this.log(`[relay] ${job.kind} ${job.model} dropped after ${durationMs} ms: the job is no longer open`);
      return;
    }

    this.stats.record(durationMs, outcome.ok ? null : outcome.error.code);
    const body: RelayResultRequest = outcome.ok
      ? { runnerId: this.runnerId!, leaseId: job.leaseId, ok: true, result: outcome.result }
      : { runnerId: this.runnerId!, leaseId: job.leaseId, ok: false, error: outcome.error };
    let posted = 'not posted';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        posted = (await this.deps.api.result(job.id, body)).status;
        break;
      } catch (err) {
        posted = `not posted (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    this.log(outcome.ok
      ? `[relay] ${job.kind} ${job.model} ok in ${durationMs} ms (${posted})`
      : `[relay] ${job.kind} ${job.model} failed in ${durationMs} ms: ${outcome.error.code}${outcome.error.httpStatus ? ` HTTP ${outcome.error.httpStatus}` : ''} (${posted})`);

    // The tag is gone, or the server did not answer: look again so the advert
    // and the next claim name only what is really served.
    if (!outcome.ok && (outcome.error.code === 'model_missing' || (outcome.error.code === 'ollama_error' && outcome.error.httpStatus === undefined))) {
      let changed = false;
      try { changed = await this.deps.server.probe(); } catch { /* never throws */ }
      if (changed || outcome.error.code === 'model_missing') this.deps.onAdvertChanged?.();
    }
  }

  private async runEmbed(o: OpenJob): Promise<RelayJobResult> {
    const { job } = o;
    const payload = job.payload;
    if (!isRelayEmbedPayload(payload)) throw new LocalModelError('bad_result', 'the embed job has no readable payload');
    const { vectors, promptTokens } = await this.deps.server.embed(job.model, payload.inputs, o.abort.signal);
    if (vectors.length !== payload.inputs.length) {
      throw new LocalModelError('bad_result', `the model returned ${vectors.length} vectors for ${payload.inputs.length} inputs`);
    }
    for (const [i, v] of vectors.entries()) {
      if (v.length !== payload.dimensions) {
        throw new LocalModelError('dimension_mismatch', `vector ${i} has ${v.length} dimensions; the job asks for ${payload.dimensions}`);
      }
      if (!v.every(x => typeof x === 'number' && Number.isFinite(x))) {
        throw new LocalModelError('bad_result', `vector ${i} holds a value that is not a finite number`);
      }
    }
    return { vectors, dimensions: payload.dimensions, model: job.model, ...(promptTokens !== undefined ? { promptTokens } : {}) };
  }

  private async runChat(o: OpenJob): Promise<RelayJobResult> {
    const { job } = o;
    const payload = job.payload;
    if (!isRelayChatPayload(payload)) throw new LocalModelError('bad_result', 'the chat job has no readable payload');
    const messages = payload.messages.filter((m): m is LocalChatMessage =>
      !!m && typeof m === 'object' && typeof (m as LocalChatMessage).role === 'string' && typeof (m as LocalChatMessage).content === 'string');

    // New text is posted on an interval, one post at a time, as the piece
    // generated since the last post: the server appends.
    let pending = '';
    let posting: Promise<void> | null = null;
    const flush = () => {
      if (posting || !pending || o.dropped) return;
      const part = pending;
      pending = '';
      posting = this.postProgress(o, part).finally(() => { posting = null; });
    };
    const timer = setInterval(flush, this.deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
    timer.unref?.();
    try {
      const result = await this.deps.server.chat(job.model, messages, (payload.options ?? {}) as LocalChatOptions, {
        signal: o.abort.signal,
        onDelta: (delta) => { pending += delta; },
      });
      return {
        text: result.text,
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.evalRate !== undefined ? { evalRate: result.evalRate } : {}),
      };
    } finally {
      clearInterval(timer);
      // Let a post in flight land before the result, so the server never appends after it.
      if (posting) await posting;
    }
  }
}

/** The relay routes over HTTP with the runner's own key. */
export function createRelayHttpApi(cfg: { serverUrl: string; apiKey: string; fetch?: typeof fetch }): RelayApi {
  const post = (path: string, body: unknown) => (cfg.fetch ?? fetch)(`${cfg.serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return {
    async claim(body) {
      const res = await post('/api/relay/jobs/claim', body);
      if (!res.ok) throw new Error(`relay claim returned HTTP ${res.status}`);
      return await res.json() as RelayClaimResponse;
    },
    async result(jobId, body) {
      const res = await post(`/api/relay/jobs/${jobId}/result`, body);
      if (res.status === 409) return { status: 'conflict' };
      if (res.status === 410 || res.status === 404) return { status: 'gone' };
      if (!res.ok) throw new Error(`relay result returned HTTP ${res.status}`);
      const data = await res.json() as { status?: string };
      return { status: data.status === 'failed' || data.status === 'requeued' ? data.status : 'done' };
    },
    async progress(jobId, body) {
      const res = await post(`/api/relay/jobs/${jobId}/progress`, body);
      if (res.status === 409 || res.status === 410 || res.status === 404) return 'stop';
      if (!res.ok) throw new Error(`relay progress returned HTTP ${res.status}`);
      return 'ok';
    },
  };
}

/** The runner's relay poller from its config and environment; a disabled one when the relay is opted out. */
export function createRelayPoller(cfg: {
  builddServer: string;
  apiKey: string;
  held: () => boolean;
  env?: Record<string, string | undefined>;
  enabled?: boolean;
  onAdvertChanged?: () => void;
}): RelayPoller {
  const target = resolveLocalModelServer(cfg.env ?? process.env);
  return new RelayPoller({
    api: createRelayHttpApi({ serverUrl: cfg.builddServer, apiKey: cfg.apiKey }),
    // An opted-out poller never touches its server; the origin is a placeholder.
    server: new LocalModelServer({ origin: target?.origin ?? 'http://127.0.0.1:11434' }),
    held: cfg.held,
    enabled: cfg.enabled !== false && target !== null,
    onAdvertChanged: cfg.onAdvertChanged,
  });
}
