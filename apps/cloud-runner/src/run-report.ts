/**
 * The per-run report: what one attempt cost in time and traffic, assembled
 * when the run ends, stored in the WorkerAgent's state and delivered to buildd
 * as a worker artifact (`type: data`, key `cloud-run-report:<workerId>`).
 *
 * Runtime-free and pure except `deliverRunReport` and `countResponseBytes`,
 * whose I/O is passed in. Bun tests cover all of it (run-report.test.ts).
 *
 * What never goes in: header values, tokens, URLs, request or response
 * bodies, runner output. `assembleRunReport` builds the report from an
 * allowlist of typed fields and drops any identifier that does not look like
 * one, so a stray credential passed in by mistake cannot come out the other
 * side.
 */
import type { CrashReport, RunOutcome } from './lifecycle';

/**
 * 2: adds `repo` (warm restore vs clone) and the restore/fetch/upload durations.
 * 3: adds `resume` (a parked run continued in a new container) and the park durations.
 */
export const RUN_REPORT_VERSION = 3;

/** Artifact key prefix; the full key is `cloud-run-report:<workerId>` (one per claim). */
export const RUN_REPORT_KEY_PREFIX = 'cloud-run-report';
export const RUN_REPORT_KIND = 'cloud-run-report';

/**
 * Container label that ties Cloudflare's container analytics back to one run
 * (`labels_has: "bd_run=<taskId>.<attempt>"`, or group by `label(name: "bd_run")`).
 * Label names are limited to 16 bytes.
 */
export const RUN_LABEL_NAME = 'bd_run';

export function runLabel(taskId: string, attempt: number): string {
  return `${taskId}.${attempt}`;
}

// ── Runner phase lines ────────────────────────────────────────────────────────
// Mirrors apps/runner/src/phase-lines.ts (not imported: that would pull the
// runner into the Worker bundle). run-report.test.ts asserts they stay equal.

export const PHASE_LINE_PREFIX = 'BUILDD_PHASE=';
export const RUN_PHASES = [
  'clone_start', 'clone_end', 'install_start', 'install_end',
  'restore_warm_start', 'restore_warm_end', 'fetch_start', 'fetch_end',
  'warm_upload_start', 'warm_upload_end',
  'park_start', 'park_end', 'restore_park_start', 'restore_park_end',
] as const;
export type RunPhase = typeof RUN_PHASES[number];
export type RunnerPhases = Partial<Record<RunPhase, number>>;

const PHASE_LINE_RE = /^BUILDD_PHASE=([a-z_]+) (\d{1,16})$/;

/** `{ phase, at }` from a `BUILDD_PHASE=<phase> <epoch ms>` line, or null. */
export function parsePhaseLine(line: string): { phase: RunPhase; at: number } | null {
  const m = PHASE_LINE_RE.exec(line.trim());
  if (!m) return null;
  const phase = m[1] as RunPhase;
  if (!RUN_PHASES.includes(phase)) return null;
  const at = Number(m[2]);
  return Number.isSafeInteger(at) && at > 0 ? { phase, at } : null;
}

export const METRIC_LINE_PREFIX = 'BUILDD_METRIC=';
export const RUN_METRICS = [
  'clone_bytes', 'restore_bytes', 'fetch_bytes', 'cache_bytes', 'snapshot_age_ms', 'warm_upload_bytes',
  'park_bytes', 'resume_layer',
] as const;
export type RunMetric = typeof RUN_METRICS[number];
export type RunnerMetrics = Partial<Record<RunMetric, number>>;

export const REPO_SOURCE_LINE_PREFIX = 'BUILDD_REPO_SOURCE=';
export const REPO_FALLBACK_REASONS = ['disabled', 'no_snapshot', 'unavailable', 'disk', 'restore_failed'] as const;
export type RepoFallbackReason = typeof REPO_FALLBACK_REASONS[number];
export type RepoSourceLine = { source: 'warm' } | { source: 'clone'; reason: RepoFallbackReason };

const METRIC_LINE_RE = /^BUILDD_METRIC=([a-z_]+) (\d{1,16})$/;
const SOURCE_LINE_RE = /^BUILDD_REPO_SOURCE=(warm|clone [a-z_]+)$/;

/** `{ metric, value }` from a `BUILDD_METRIC=<name> <integer>` line, or null. */
export function parseMetricLine(line: string): { metric: RunMetric; value: number } | null {
  const m = METRIC_LINE_RE.exec(line.trim());
  if (!m) return null;
  const metric = m[1] as RunMetric;
  if (!RUN_METRICS.includes(metric)) return null;
  const value = Number(m[2]);
  return Number.isSafeInteger(value) ? { metric, value } : null;
}

/** From a `BUILDD_REPO_SOURCE=warm` or `BUILDD_REPO_SOURCE=clone <reason>` line, or null. */
export function parseRepoSourceLine(line: string): RepoSourceLine | null {
  const m = SOURCE_LINE_RE.exec(line.trim());
  if (!m) return null;
  if (m[1] === 'warm') return { source: 'warm' };
  const reason = m[1]!.slice('clone '.length) as RepoFallbackReason;
  return REPO_FALLBACK_REASONS.includes(reason) ? { source: 'clone', reason } : null;
}

/** Last value wins. */
export function recordMetric(metrics: RunnerMetrics | undefined, metric: RunMetric, value: number): RunnerMetrics {
  return { ...(metrics ?? {}), [metric]: value };
}

/** First occurrence wins: a second clone or install in the same run is not re-timed. */
export function recordPhase(phases: RunnerPhases | undefined, phase: RunPhase, at: number): RunnerPhases {
  const current = phases ?? {};
  return current[phase] !== undefined ? current : { ...current, [phase]: at };
}

// ── Egress counters ───────────────────────────────────────────────────────────

/**
 * model: api.anthropic.com. github: the GitHub hosts. passthrough: a request
 * to an intercepted host that the handler forwarded untouched. Hosts that are
 * not intercepted never reach the handler and are not counted.
 */
export const EGRESS_CLASSES = ['model', 'github', 'passthrough'] as const;
export type EgressClass = typeof EGRESS_CLASSES[number];

export interface EgressClassCounters {
  requests: number;
  /** Refused by the handler (plain HTTP, wrong port, model route unconfigured). */
  rejected: number;
  /** Response body bytes the container read to the end (streamed bodies included). */
  responseBytes: number;
}
export type EgressCounters = Record<EgressClass, EgressClassCounters>;

export function emptyEgressCounters(): EgressCounters {
  return {
    model: { requests: 0, rejected: 0, responseBytes: 0 },
    github: { requests: 0, rejected: 0, responseBytes: 0 },
    passthrough: { requests: 0, rejected: 0, responseBytes: 0 },
  };
}

export function isEgressClass(v: unknown): v is EgressClass {
  return typeof v === 'string' && (EGRESS_CLASSES as readonly string[]).includes(v);
}

/** Map outbound.ts's host kind to the report's class. */
export function egressClassForKind(kind: 'anthropic' | 'github' | 'passthrough'): EgressClass {
  return kind === 'anthropic' ? 'model' : kind;
}

/** The only shape the handler sends the agent. No URL, no headers. */
export type EgressEvent =
  | { type: 'request'; cls: EgressClass; at: number; rejected?: boolean }
  | { type: 'bytes'; cls: EgressClass; bytes: number };

export function isEgressEvent(v: unknown): v is EgressEvent {
  const e = v as Record<string, unknown> | null;
  if (!e || !isEgressClass(e.cls)) return false;
  if (e.type === 'request') return typeof e.at === 'number' && Number.isFinite(e.at);
  if (e.type === 'bytes') return typeof e.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes >= 0;
  return false;
}

export function applyEgressEvent(counters: EgressCounters, e: EgressEvent): void {
  const c = counters[e.cls];
  if (e.type === 'request') {
    c.requests += 1;
    if (e.rejected) c.rejected += 1;
  } else {
    c.responseBytes += Math.floor(e.bytes);
  }
}

/**
 * Wrap a response so `onDone(bytes)` fires once the body has been read to the
 * end (or failed). A body the container abandons is not reported, so
 * responseBytes is a lower bound. Status and headers are kept.
 */
export function countResponseBytes(res: Response, onDone: (bytes: number) => void): Response {
  if (!res.body) {
    onDone(0);
    return res;
  }
  let bytes = 0;
  let done = false;
  const finish = () => { if (!done) { done = true; onDone(bytes); } };
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() { finish(); },
  });
  const body = res.body.pipeThrough(counter);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ── Timings (persisted in RunState while the run is live) ─────────────────────

export interface RunTimings {
  /** Epoch ms, agent clock unless noted. */
  containerRunningAt?: number;
  /** When the `BUILDD_WORKER_ID=` line was read. */
  claimedAt?: number;
  /** First request the egress handler saw for api.anthropic.com. */
  firstModelRequestAt?: number;
  exitedAt?: number;
  /** From `BUILDD_PHASE=` lines: the container's clock. */
  runnerPhases?: RunnerPhases;
  /** From `BUILDD_METRIC=` lines. */
  runnerMetrics?: RunnerMetrics;
  /** From the `BUILDD_REPO_SOURCE=` line. */
  repoSource?: RepoSourceLine;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export interface RunReport {
  kind: typeof RUN_REPORT_KIND;
  version: typeof RUN_REPORT_VERSION;
  taskId: string | null;
  attempt: number;
  workerId: string | null;
  /**
   * The Durable Object ID the container is bound to. Cloudflare exposes no
   * instance ID on `ctx.container`; its docs describe this ID (the container's
   * CLOUDFLARE_DURABLE_OBJECT_ID) as the one that identifies the instance on
   * the dashboard. One agent reuses it across attempts, so join analytics on
   * `runLabel` as well, or on the time window.
   */
  containerInstanceId: string | null;
  /** Value of the `bd_run` container label for this attempt. */
  runLabel: string | null;
  instanceType: string | null;
  timestamps: {
    dispatchReceivedAt: number | null;
    containerRunningAt: number | null;
    claimedAt: number | null;
    firstModelRequestAt: number | null;
    exitedAt: number | null;
  };
  /** Derived; null when either end is missing. */
  durationsMs: {
    containerStart: number | null;
    toClaim: number | null;
    clone: number | null;
    install: number | null;
    /** Warm snapshot download + unpack (instead of `clone`). */
    restoreWarm: number | null;
    /** The `git fetch` after a warm restore. */
    fetch: number | null;
    /** Uploading a new warm generation at the end of the run. */
    warmUpload: number | null;
    /** Building and uploading the park bundle. */
    park: number | null;
    /** Downloading and applying the park bundle in a resumed run. */
    restorePark: number | null;
    toFirstModelRequest: number | null;
    total: number | null;
  };
  runnerPhases: RunnerPhases;
  /**
   * How the repo got onto the disk. `source` null: the runner printed no
   * source line (warm repos off, or no clone in this run).
   */
  repo: {
    source: 'warm' | 'clone' | null;
    fallbackReason: RepoFallbackReason | null;
    snapshotAgeMs: number | null;
    bytes: { clone: number | null; restore: number | null; fetch: number | null; cache: number | null; upload: number | null };
  };
  /**
   * Resumable runs. `resumed`: this attempt continued a parked worker.
   * `gapMs`: from the end of the parked attempt to this dispatch (the answer
   * plus the webhook). `layer`: 1 = the transcript resumed, 2 = rebuilt from a
   * text reconstruction. `parkBytes`: the park bundle this attempt uploaded.
   */
  resume: { resumed: boolean; gapMs: number | null; layer: 1 | 2 | null; parkBytes: number | null };
  egress: EgressCounters;
  exitCode: number | null;
  outcome: RunOutcome | null;
  crashReport: CrashReport | null;
}

export interface RunReportInput {
  taskId: string | null | undefined;
  attempt: number;
  workerId?: string | null;
  containerInstanceId?: string | null;
  instanceType?: string | null;
  dispatchReceivedAt?: number;
  timings?: RunTimings;
  egress?: EgressCounters;
  exitCode?: number | null;
  outcome?: RunOutcome;
  crashReport?: CrashReport;
  resumed?: boolean;
  /** End of the parked attempt this one resumes (agent clock). */
  parkedAt?: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INSTANCE_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OUTCOMES: readonly RunOutcome[] = ['done', 'failed', 'refused', 'usage', 'parked', 'crashed'];
const CRASH_REPORTS: readonly CrashReport[] = ['sent', 'rejected', 'error', 'no_worker_id'];

// Shapes of credentials an identifier must never be mistaken for (Anthropic,
// buildd, GitHub, Slack, AWS, generic `key-`/`token`). Task and worker IDs are
// UUIDs, the instance ID is hex; none of them starts like this.
const CREDENTIAL_SHAPE_RE = /^(sk-|bld_|bldt_|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|ASIA)|token|secret|passw/i;

function id(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) && !CREDENTIAL_SHAPE_RE.test(v) ? v : null;
}
function ts(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
function span(from: number | null, to: number | null): number | null {
  return from !== null && to !== null && to >= from ? to - from : null;
}

export function assembleRunReport(input: RunReportInput): RunReport {
  const taskId = id(input.taskId);
  const attempt = count(input.attempt);
  const t = input.timings ?? {};
  const phases: RunnerPhases = {};
  for (const p of RUN_PHASES) {
    const v = ts(t.runnerPhases?.[p]);
    if (v !== null) phases[p] = v;
  }
  const egress = emptyEgressCounters();
  for (const cls of EGRESS_CLASSES) {
    const c = input.egress?.[cls];
    egress[cls] = { requests: count(c?.requests), rejected: count(c?.rejected), responseBytes: count(c?.responseBytes) };
  }
  const timestamps = {
    dispatchReceivedAt: ts(input.dispatchReceivedAt),
    containerRunningAt: ts(t.containerRunningAt),
    claimedAt: ts(t.claimedAt),
    firstModelRequestAt: ts(t.firstModelRequestAt),
    exitedAt: ts(t.exitedAt),
  };
  const phase = (p: RunPhase) => phases[p] ?? null;
  const metrics = t.runnerMetrics ?? {};
  const metric = (m: RunMetric): number | null => {
    const v = metrics[m];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  };
  const src = t.repoSource as { source?: unknown; reason?: unknown } | undefined;
  const source = src?.source === 'warm' || src?.source === 'clone' ? src.source : null;
  const fallbackReason = source === 'clone' && REPO_FALLBACK_REASONS.includes(src?.reason as RepoFallbackReason) ? src!.reason as RepoFallbackReason : null;
  return {
    kind: RUN_REPORT_KIND,
    version: RUN_REPORT_VERSION,
    taskId,
    attempt,
    workerId: id(input.workerId),
    containerInstanceId: id(input.containerInstanceId),
    runLabel: taskId && attempt > 0 ? runLabel(taskId, attempt) : null,
    instanceType: typeof input.instanceType === 'string' && INSTANCE_TYPE_RE.test(input.instanceType) ? input.instanceType : null,
    timestamps,
    durationsMs: {
      containerStart: span(timestamps.dispatchReceivedAt, timestamps.containerRunningAt),
      toClaim: span(timestamps.containerRunningAt, timestamps.claimedAt),
      clone: span(phase('clone_start'), phase('clone_end')),
      install: span(phase('install_start'), phase('install_end')),
      restoreWarm: span(phase('restore_warm_start'), phase('restore_warm_end')),
      fetch: span(phase('fetch_start'), phase('fetch_end')),
      warmUpload: span(phase('warm_upload_start'), phase('warm_upload_end')),
      park: span(phase('park_start'), phase('park_end')),
      restorePark: span(phase('restore_park_start'), phase('restore_park_end')),
      toFirstModelRequest: span(timestamps.claimedAt, timestamps.firstModelRequestAt),
      total: span(timestamps.dispatchReceivedAt, timestamps.exitedAt),
    },
    runnerPhases: phases,
    repo: {
      source,
      fallbackReason,
      snapshotAgeMs: metric('snapshot_age_ms'),
      bytes: {
        clone: metric('clone_bytes'),
        restore: metric('restore_bytes'),
        fetch: metric('fetch_bytes'),
        cache: metric('cache_bytes'),
        upload: metric('warm_upload_bytes'),
      },
    },
    resume: {
      resumed: input.resumed === true,
      gapMs: input.resumed === true ? span(ts(input.parkedAt), timestamps.dispatchReceivedAt) : null,
      layer: metric('resume_layer') === 1 ? 1 : metric('resume_layer') === 2 ? 2 : null,
      parkBytes: metric('park_bytes'),
    },
    egress,
    exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) ? input.exitCode : null,
    outcome: input.outcome && OUTCOMES.includes(input.outcome) ? input.outcome : null,
    crashReport: input.crashReport && CRASH_REPORTS.includes(input.crashReport) ? input.crashReport : null,
  };
}

// ── Delivery ──────────────────────────────────────────────────────────────────

/** What happened to the best-effort artifact POST. `pending` while in flight. */
export type ReportDelivery = 'pending' | 'sent' | 'rejected' | 'error' | 'no_worker_id' | 'not_configured';

export type StoredRunReport = RunReport & { delivery: ReportDelivery };

export const REPORT_HISTORY_MAX = 10;

export function reportArtifactKey(workerId: string): string {
  return `${RUN_REPORT_KEY_PREFIX}:${workerId}`;
}

/**
 * `POST <server>/api/workers/<workerId>/artifacts`, authenticated with the
 * runner key the container claimed with (the route requires the worker's own
 * account). The report goes in `metadata.report` (kept for every workspace)
 * and, pretty-printed, in `content`.
 */
export function runReportArtifactRequest(
  server: string,
  apiKey: string,
  report: RunReport,
): { url: string; init: RequestInit } | null {
  if (!report.workerId) return null;
  const body = {
    type: 'data',
    key: reportArtifactKey(report.workerId),
    title: `Cloud run report: attempt ${report.attempt}, ${report.outcome ?? 'unknown'}`,
    content: JSON.stringify(report, null, 2),
    metadata: { kind: RUN_REPORT_KIND, version: RUN_REPORT_VERSION, report },
  };
  return {
    url: `${server.replace(/\/+$/, '')}/api/workers/${encodeURIComponent(report.workerId)}/artifacts`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
  };
}

export interface DeliveryDeps {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  timeoutMs?: number;
  retryDelayMs?: number;
}

function retryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * At most two tries: one retry after a network error or a 5xx/429/408, none
 * after any other status. Never throws.
 */
export async function deliverRunReport(
  deps: DeliveryDeps,
  cfg: { server?: string; apiKey?: string },
  report: RunReport,
): Promise<Exclude<ReportDelivery, 'pending'>> {
  if (!report.workerId) return 'no_worker_id';
  if (!cfg.server || !cfg.apiKey) return 'not_configured';
  const req = runReportArtifactRequest(cfg.server, cfg.apiKey, report)!;
  let last: Exclude<ReportDelivery, 'pending'> = 'error';
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    if (tryNo > 0) await deps.sleep(deps.retryDelayMs ?? 1_000);
    try {
      const res = await deps.fetch(req.url, { ...req.init, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
      if (res.ok) return 'sent';
      deps.log(`[cloud-runner] run report returned ${res.status}`);
      last = 'rejected';
      if (!retryable(res.status)) return last;
    } catch (err) {
      deps.log(`[cloud-runner] run report failed: ${err instanceof Error ? err.message : String(err)}`);
      last = 'error';
    }
  }
  return last;
}
