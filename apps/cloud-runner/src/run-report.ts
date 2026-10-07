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
import type { ModelAuth } from './owner-seat';
import type { AgentRestart, CrashReport, RunOutcome } from './lifecycle';
import { prepMsOf, type ReusedContainer } from './container-lease';
import {
  RUNNER_CLASSES,
  normalizeRunnerSizeDecision,
  runnerSeconds,
  type RunnerSize,
  type RunnerSizeDecision,
  type RunnerSizeReason,
  type RunnerSizeSource,
} from './runner-class';

/**
 * 2: adds `repo` (warm restore vs clone) and the restore/fetch/upload durations.
 * 3: adds `resume` (a parked run continued in a new container) and the park durations.
 * 4: adds `schedule` (a `task.scheduled` start: when it was due, when it started).
 * 5: adds `deferredRetry` (a `deferred`/`start_deferred` outcome's self-scheduled backoff retry).
 * 6: adds `repo.cacheSkipped`, `repo.bytes.cacheRaw` and `durationsMs.restoreCache` (compressed cache tarball).
 * 7: adds `resources` (memory peak, disk minimum), `interruption` and `runnerSize` (container class, weighted runner-seconds).
 * 8: adds `agentRestarts` (each time the agent restarted under the attempt, and what it did about the run).
 * 9: adds `reusedContainer` (the attempt ran in a container an earlier run of the workspace left warm).
 * 10: adds `modelAuth` (`owner_seat` | `metered`: which kind of credential paid for the model calls; never the credential).
 * 11: `reusedContainer` measures instead of estimating: `savedRestoreMs` (the previous run's prep) is replaced by
 *     `resetMs`, `prepMs`, `baselinePrepMs` and `savedMs` (negative when reuse cost time); adds the `restore_reuse_*`
 *     phases, `durationsMs.restoreReuse` and `repo.source` `reuse` (the clone grown from the packs a reset kept).
 */
export const RUN_REPORT_VERSION = 11;

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
  'restore_cache_start', 'restore_cache_end',
  'restore_reuse_start', 'restore_reuse_end',
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
  'park_bytes', 'resume_layer', 'warm_repo_bytes', 'cache_raw_bytes',
  'mem_peak_bytes', 'mem_limit_bytes', 'disk_free_min_bytes', 'disk_total_bytes',
] as const;
export type RunMetric = typeof RUN_METRICS[number];
export type RunnerMetrics = Partial<Record<RunMetric, number>>;

export const WARM_UPLOAD_LINE_PREFIX = 'BUILDD_WARM_UPLOAD=';
export const WARM_UPLOAD_SKIP_REASONS = ['too_large'] as const;
export type WarmUploadSkipReason = typeof WARM_UPLOAD_SKIP_REASONS[number];
export type WarmUploadLine = { skipped: WarmUploadSkipReason };
const WARM_UPLOAD_LINE_RE = /^BUILDD_WARM_UPLOAD=skipped ([a-z_]+)$/;

/** From a `BUILDD_WARM_UPLOAD=skipped <reason>` line, or null. */
export function parseWarmUploadLine(line: string): WarmUploadLine | null {
  const m = WARM_UPLOAD_LINE_RE.exec(line.trim());
  const reason = m?.[1] as WarmUploadSkipReason | undefined;
  return reason && WARM_UPLOAD_SKIP_REASONS.includes(reason) ? { skipped: reason } : null;
}

/**
 * `BUILDD_CACHE_SKIPPED=<part> <bytes> <cap>`: a subtree of the dependency
 * cache (or the whole cache tarball) was left out of the warm upload for
 * size. `bytes` is its size on disk, `cap` the workspace's warm cap.
 */
export const CACHE_SKIPPED_LINE_PREFIX = 'BUILDD_CACHE_SKIPPED=';
export const CACHE_SKIP_PARTS = ['pnpm-store', 'cache'] as const;
export type CacheSkipPart = typeof CACHE_SKIP_PARTS[number];
export type CacheSkippedLine = { part: CacheSkipPart; bytes: number; cap: number };
const CACHE_SKIPPED_LINE_RE = /^BUILDD_CACHE_SKIPPED=([a-z-]+) (\d{1,16}) (\d{1,16})$/;

/** From a `BUILDD_CACHE_SKIPPED=<part> <bytes> <cap>` line, or null. */
export function parseCacheSkippedLine(line: string): CacheSkippedLine | null {
  const m = CACHE_SKIPPED_LINE_RE.exec(line.trim());
  if (!m || !CACHE_SKIP_PARTS.includes(m[1] as CacheSkipPart)) return null;
  const bytes = Number(m[2]), cap = Number(m[3]);
  return Number.isSafeInteger(bytes) && Number.isSafeInteger(cap) ? { part: m[1] as CacheSkipPart, bytes, cap } : null;
}

function cacheSkipped(v: unknown): CacheSkippedLine | null {
  const c = v as Partial<CacheSkippedLine> | undefined;
  if (!c || !CACHE_SKIP_PARTS.includes(c.part as CacheSkipPart)) return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return ok(c.bytes) && ok(c.cap) ? { part: c.part as CacheSkipPart, bytes: c.bytes!, cap: c.cap! } : null;
}

export const REPO_SOURCE_LINE_PREFIX = 'BUILDD_REPO_SOURCE=';
export const REPO_FALLBACK_REASONS = ['disabled', 'no_snapshot', 'unavailable', 'disk', 'restore_failed'] as const;
export type RepoFallbackReason = typeof REPO_FALLBACK_REASONS[number];
export type RepoSourceLine = { source: 'warm' } | { source: 'reuse' } | { source: 'clone'; reason: RepoFallbackReason };

const METRIC_LINE_RE = /^BUILDD_METRIC=([a-z_]+) (\d{1,16})$/;
const SOURCE_LINE_RE = /^BUILDD_REPO_SOURCE=(warm|reuse|clone [a-z_]+)$/;

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
  if (m[1] === 'warm' || m[1] === 'reuse') return { source: m[1] };
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

/**
 * Why the handler refused a request. Mirrors outbound.ts RejectReason.
 * `merge_blocked`: a direct PR merge (REST or GraphQL) or a push to a
 * protected branch — see outbound.ts "Merge guard".
 * `push_not_allowed`: a push or ref write outside the grant's
 * `pushableBranches` — see outbound.ts "Push allow-list".
 */
export const REJECT_REASONS = ['path', 'unconfigured', 'plain_http', 'port', 'unparseable', 'merge_blocked', 'push_not_allowed', 'other'] as const;
export type RejectReason = typeof REJECT_REASONS[number];
/** Mirrors outbound.ts RejectedPathLabel: where a `path` refusal was going, as a fixed label. */
export const REJECTED_PATH_LABELS = ['api_hello', 'event_logging', 'oauth', 'claude_code_api', 'other_api', 'files', 'batches', 'other_v1', 'other'] as const;
export type RejectedPathLabelName = typeof REJECTED_PATH_LABELS[number];

/**
 * Why a forwarded GitHub request carried no injected credential. Mirrors
 * outbound.ts GithubUnauthenticatedReason. Fixed labels only.
 *  - no_grant: the agent had no live run to hand a token to
 *  - grant_fetch_failed: buildd's github-token endpoint refused or failed (or the cache is backing off after that)
 *  - grant_expired: the cached token was past its expiry
 *  - out_of_scope: the path is not the task's repo (another repo, /user, codeload)
 */
export const GITHUB_UNAUTH_REASONS = ['no_grant', 'grant_fetch_failed', 'grant_expired', 'out_of_scope'] as const;
export type GithubUnauthReason = typeof GITHUB_UNAUTH_REASONS[number];
/** A GitHub forward's credential state: ours was attached, or why not. */
export type GithubAuthLabel = 'credentialed' | GithubUnauthReason;

/**
 * The only shape the handler sends the agent. No URL, no headers: a refusal
 * carries only its reason, an upstream answer only its status code, and a
 * GitHub forward only whether our credential went with it (`auth`).
 * `grant_failure` comes from the agent itself: buildd's github-token endpoint
 * answered `status` (0: nothing answered).
 */
export type EgressEvent =
  | { type: 'request'; cls: EgressClass; at: number; rejected?: boolean; reason?: RejectReason; pathLabel?: RejectedPathLabelName; auth?: GithubAuthLabel }
  | { type: 'bytes'; cls: EgressClass; bytes: number }
  | { type: 'status'; cls: EgressClass; status: number; auth?: GithubAuthLabel }
  | { type: 'grant_failure'; cls: 'github'; status: number }
  | GithubRateLimitEvent;

// ── GitHub throttling ─────────────────────────────────────────────────────────

/**
 * GitHub's own rate-limit signals on a throttled answer (a 429, or a 403 that
 * carries one), so the report can tell the installation's primary limit
 * (`x-ratelimit-remaining: 0` with a resource) from a secondary limit (the
 * body says so, usually with `retry-after`) from git-only throttling (a bare
 * 429 on github.com). Numbers and fixed labels only.
 */
export const GITHUB_HOST_LABELS = ['github.com', 'api.github.com', 'uploads.github.com', 'codeload.github.com', 'other'] as const;
export type GithubHostLabel = typeof GITHUB_HOST_LABELS[number];
/** `x-ratelimit-resource` values GitHub documents; anything else is `other`, an absent header `none`. */
export const GITHUB_RATE_LIMIT_RESOURCES = [
  'core', 'search', 'code_search', 'graphql', 'integration_manifest', 'source_import', 'code_scanning_upload',
  'code_scanning_autofix', 'actions_runner_registration', 'scim', 'dependency_snapshots', 'dependency_sbom',
  'audit_log', 'audit_log_streaming', 'other', 'none',
] as const;
export type GithubRateLimitResource = typeof GITHUB_RATE_LIMIT_RESOURCES[number];
export const RETRY_AFTER_BUCKETS = ['none', '0', '1-10', '11-60', '61-300', '301+'] as const;
export type RetryAfterBucket = typeof RETRY_AFTER_BUCKETS[number];

export interface GithubRateLimitEvent {
  type: 'rate_limit';
  cls: 'github';
  status: number;
  host: GithubHostLabel;
  /** `retry-after` in seconds (an HTTP date converted), or null when absent. */
  retryAfterS: number | null;
  /** `x-ratelimit-remaining`, or null when absent. */
  remaining: number | null;
  resource: GithubRateLimitResource;
  /** The first bytes of the body say "secondary rate limit". */
  secondary: boolean;
}

/** How much of a throttled body is read, at most, to look for "secondary rate limit". Never stored. */
export const THROTTLE_BODY_PREFIX_BYTES = 512;
const MAX_RETRY_AFTER_S = 7 * 24 * 3600;

function retryAfterSeconds(value: string | null, now: number): number | null {
  const v = (value ?? '').trim();
  if (/^\d{1,9}$/.test(v)) return Math.min(Number(v), MAX_RETRY_AFTER_S);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_S, Math.max(0, Math.ceil((at - now) / 1000))) : null;
}

export function retryAfterBucket(s: number | null): RetryAfterBucket {
  if (s === null) return 'none';
  if (s === 0) return '0';
  if (s <= 10) return '1-10';
  if (s <= 60) return '11-60';
  if (s <= 300) return '61-300';
  return '301+';
}

const hostLabel = (h: unknown): GithubHostLabel =>
  (GITHUB_HOST_LABELS as readonly string[]).includes(h as string) && h !== 'other' ? h as GithubHostLabel : 'other';
const resourceLabel = (r: string | null): GithubRateLimitResource => {
  if (r === null || r.trim() === '') return 'none';
  const v = r.trim().toLowerCase();
  return (GITHUB_RATE_LIMIT_RESOURCES as readonly string[]).includes(v) && v !== 'none' ? v as GithubRateLimitResource : 'other';
};

/**
 * The event for a GitHub answer, or null when it is not throttling: every
 * 429, and a 403 only when it carries a rate-limit signal (a permission 403
 * is already in `errorStatuses`).
 */
export function githubRateLimitEvent(input: { status: number; host: string; headers: Headers; bodyPrefix: string; now?: number }): GithubRateLimitEvent | null {
  if (input.status !== 429 && input.status !== 403) return null;
  const retryAfterS = retryAfterSeconds(input.headers.get('retry-after'), input.now ?? Date.now());
  const rawRemaining = (input.headers.get('x-ratelimit-remaining') ?? '').trim();
  const remaining = /^\d{1,9}$/.test(rawRemaining) ? Number(rawRemaining) : null;
  const secondary = /secondary rate limit/i.test(input.bodyPrefix);
  if (input.status === 403 && retryAfterS === null && remaining !== 0 && !secondary && !/rate limit/i.test(input.bodyPrefix)) return null;
  return {
    type: 'rate_limit',
    cls: 'github',
    status: input.status,
    host: hostLabel(input.host),
    retryAfterS,
    remaining,
    resource: resourceLabel(input.headers.get('x-ratelimit-resource')),
    secondary,
  };
}

/** Up to `max` bytes of a body as text, then cancel the rest. Pass a clone: the body is consumed. */
async function readPrefix(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

/**
 * The throttling event for a GitHub response, reading at most
 * THROTTLE_BODY_PREFIX_BYTES of `res`'s body (pass a clone) and only for a
 * 403 or 429. Null otherwise.
 */
export async function inspectGithubThrottle(res: Response, host: string): Promise<GithubRateLimitEvent | null> {
  if (res.status !== 429 && res.status !== 403) return null;
  let prefix = '';
  try { prefix = await readPrefix(res, THROTTLE_BODY_PREFIX_BYTES); } catch { /* headers alone, then */ }
  return githubRateLimitEvent({ status: res.status, host, headers: res.headers, bodyPrefix: prefix });
}

/** The Worker console line for one throttled response: numbers, fixed labels and the task ID. */
export function throttleLogLine(taskId: string, e: GithubRateLimitEvent): string {
  const n = (v: number | null) => (v === null ? 'none' : String(v));
  return `[cloud-runner] task ${taskId}: GitHub throttled ${e.status} host=${e.host} retry-after=${n(e.retryAfterS)} remaining=${n(e.remaining)} resource=${e.resource} secondary=${e.secondary}`;
}

const nullableCount = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export function isEgressEvent(v: unknown): v is EgressEvent {
  const e = v as Record<string, unknown> | null;
  if (!e || !isEgressClass(e.cls)) return false;
  if (e.type === 'rate_limit') {
    return e.cls === 'github' && typeof e.status === 'number' && Number.isInteger(e.status)
      && typeof e.host === 'string' && typeof e.resource === 'string' && typeof e.secondary === 'boolean'
      && nullableCount(e.retryAfterS) && nullableCount(e.remaining);
  }
  if (e.type === 'request') return typeof e.at === 'number' && Number.isFinite(e.at);
  if (e.type === 'bytes') return typeof e.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes >= 0;
  if (e.type === 'status') return typeof e.status === 'number' && Number.isInteger(e.status);
  if (e.type === 'grant_failure') return e.cls === 'github' && typeof e.status === 'number' && Number.isInteger(e.status);
  return false;
}

/** Per class: refusals by reason, and upstream 4xx/5xx answers by code. Counts only. */
export interface EgressClassDetail {
  rejectReasons: Partial<Record<RejectReason, number>>;
  /** `path` refusals by where they were going (fixed labels). */
  rejectedPaths: Partial<Record<RejectedPathLabelName, number>>;
  errorStatuses: Record<string, number>;
}

/**
 * GitHub only: whether our credential went with each forwarded request.
 * Settles "was that 429 anonymous?" from the report alone.
 */
export interface GithubAuthDetail {
  /** Forwards that carried the injected installation token. */
  credentialed: number;
  /** Forwards that carried none, by fixed reason. */
  unauthenticated: Partial<Record<GithubUnauthReason, number>>;
  /** Upstream 4xx/5xx on those unauthenticated forwards, by code. */
  unauthenticatedErrorStatuses: Record<string, number>;
  /** buildd's github-token endpoint refusing or failing, by status (`error`: nothing answered). */
  grantFetchFailures: Record<string, number>;
  /** Throttled GitHub answers and the signals GitHub sent with them. Absent when there were none. */
  rateLimit?: GithubRateLimitDetail;
}

export interface GithubRateLimitDetail {
  /** Throttled answers: every 429, and 403s that carried a rate-limit signal. */
  throttled: number;
  statuses: Record<string, number>;
  hosts: Partial<Record<GithubHostLabel, number>>;
  /** `retry-after` by bucket (`none`: absent). */
  retryAfter: Partial<Record<RetryAfterBucket, number>>;
  retryAfterMax: number | null;
  /** Lowest `x-ratelimit-remaining` seen (0: a primary limit was spent). */
  remainingMin: number | null;
  /** `x-ratelimit-resource` (`none`: absent, as on git's own endpoints). */
  resources: Partial<Record<GithubRateLimitResource, number>>;
  /** Answers whose body said "secondary rate limit". */
  secondary: number;
}

function emptyRateLimitDetail(): GithubRateLimitDetail {
  return { throttled: 0, statuses: {}, hosts: {}, retryAfter: {}, retryAfterMax: null, remainingMin: null, resources: {}, secondary: 0 };
}

function applyRateLimit(detail: EgressDetail, e: GithubRateLimitEvent): void {
  const r = (detail.github.rateLimit ??= emptyRateLimitDetail());
  r.throttled += 1;
  if (isErrorStatus(e.status)) bump(r.statuses, String(e.status));
  const host = hostLabel(e.host);
  r.hosts[host] = (r.hosts[host] ?? 0) + 1;
  const retryAfterS = nullableCount(e.retryAfterS) ? e.retryAfterS : null;
  const bucket = retryAfterBucket(retryAfterS);
  r.retryAfter[bucket] = (r.retryAfter[bucket] ?? 0) + 1;
  if (retryAfterS !== null) r.retryAfterMax = Math.max(r.retryAfterMax ?? 0, retryAfterS);
  if (nullableCount(e.remaining) && e.remaining !== null) r.remainingMin = Math.min(r.remainingMin ?? e.remaining, e.remaining);
  const resource = (GITHUB_RATE_LIMIT_RESOURCES as readonly string[]).includes(e.resource) ? e.resource : 'other';
  r.resources[resource] = (r.resources[resource] ?? 0) + 1;
  if (e.secondary === true) r.secondary += 1;
}

function normalizeRateLimit(input: unknown): GithubRateLimitDetail | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);
  const nn = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const out = emptyRateLimitDetail();
  out.throttled = n(src.throttled);
  if (out.throttled === 0) return undefined;
  for (const [k, v] of Object.entries((src.statuses ?? {}) as Record<string, unknown>).slice(0, MAX_STATUS_KEYS)) {
    if (/^\d{3}$/.test(k) && isErrorStatus(Number(k)) && n(v)) out.statuses[k] = n(v);
  }
  const hosts = (src.hosts ?? {}) as Record<string, unknown>;
  for (const l of GITHUB_HOST_LABELS) if (n(hosts[l])) out.hosts[l] = n(hosts[l]);
  const ra = (src.retryAfter ?? {}) as Record<string, unknown>;
  for (const b of RETRY_AFTER_BUCKETS) if (n(ra[b])) out.retryAfter[b] = n(ra[b]);
  out.retryAfterMax = nn(src.retryAfterMax);
  out.remainingMin = nn(src.remainingMin);
  const res = (src.resources ?? {}) as Record<string, unknown>;
  for (const r of GITHUB_RATE_LIMIT_RESOURCES) if (n(res[r])) out.resources[r] = n(res[r]);
  out.secondary = n(src.secondary);
  return out;
}
export type EgressDetail = Record<EgressClass, EgressClassDetail> & { github: EgressClassDetail & GithubAuthDetail };

export function emptyEgressDetail(): EgressDetail {
  return {
    model: { rejectReasons: {}, rejectedPaths: {}, errorStatuses: {} },
    github: { rejectReasons: {}, rejectedPaths: {}, errorStatuses: {}, credentialed: 0, unauthenticated: {}, unauthenticatedErrorStatuses: {}, grantFetchFailures: {} },
    passthrough: { rejectReasons: {}, rejectedPaths: {}, errorStatuses: {} },
  };
}

const MAX_STATUS_KEYS = 20;
const isErrorStatus = (code: number) => Number.isInteger(code) && code >= 400 && code <= 599;

function bump(map: Record<string, number>, key: string): void {
  if (key in map || Object.keys(map).length < MAX_STATUS_KEYS) map[key] = (map[key] ?? 0) + 1;
}

const unauthReason = (v: unknown): GithubUnauthReason =>
  (GITHUB_UNAUTH_REASONS as readonly string[]).includes(v as string) ? v as GithubUnauthReason : 'no_grant';

export function applyEgressDetail(detail: EgressDetail, e: EgressEvent): void {
  if (e.type === 'rate_limit') {
    if (e.cls === 'github') applyRateLimit(detail, e);
    return;
  }
  if (e.type === 'grant_failure') {
    if (e.cls === 'github') bump(detail.github.grantFetchFailures, isErrorStatus(e.status) ? String(e.status) : 'error');
    return;
  }
  if (e.cls === 'github' && e.type !== 'bytes' && e.auth !== undefined) {
    const g = detail.github;
    if (e.type === 'request' && !e.rejected) {
      if (e.auth === 'credentialed') g.credentialed += 1;
      else { const r = unauthReason(e.auth); g.unauthenticated[r] = (g.unauthenticated[r] ?? 0) + 1; }
    } else if (e.type === 'status' && e.auth !== 'credentialed' && isErrorStatus(e.status)) {
      bump(g.unauthenticatedErrorStatuses, String(e.status));
    }
  }
  const d = detail[e.cls];
  if (e.type === 'request' && e.rejected) {
    const reason: RejectReason = REJECT_REASONS.includes(e.reason as RejectReason) ? e.reason as RejectReason : 'other';
    d.rejectReasons[reason] = (d.rejectReasons[reason] ?? 0) + 1;
    if (e.pathLabel !== undefined) {
      const label: RejectedPathLabelName = REJECTED_PATH_LABELS.includes(e.pathLabel) ? e.pathLabel : 'other';
      d.rejectedPaths[label] = (d.rejectedPaths[label] ?? 0) + 1;
    }
  } else if (e.type === 'status' && isErrorStatus(e.status)) {
    bump(d.errorStatuses, String(e.status));
  }
}

function normalizeEgressDetail(input: unknown): EgressDetail {
  const out = emptyEgressDetail();
  const src = (input ?? {}) as Partial<Record<EgressClass, { rejectReasons?: unknown; rejectedPaths?: unknown; errorStatuses?: unknown }>>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);
  for (const cls of EGRESS_CLASSES) {
    const reasons = (src[cls]?.rejectReasons ?? {}) as Record<string, unknown>;
    for (const r of REJECT_REASONS) if (n(reasons[r])) out[cls].rejectReasons[r] = n(reasons[r]);
    const paths = (src[cls]?.rejectedPaths ?? {}) as Record<string, unknown>;
    for (const l of REJECTED_PATH_LABELS) if (n(paths[l])) out[cls].rejectedPaths[l] = n(paths[l]);
    const statuses = (src[cls]?.errorStatuses ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(statuses).slice(0, MAX_STATUS_KEYS)) {
      if (/^\d{3}$/.test(k) && isErrorStatus(Number(k)) && n(v)) out[cls].errorStatuses[k] = n(v);
    }
  }
  const g = (src.github ?? {}) as Partial<Record<keyof GithubAuthDetail, unknown>>;
  out.github.credentialed = n(g.credentialed);
  const unauth = (g.unauthenticated ?? {}) as Record<string, unknown>;
  for (const r of GITHUB_UNAUTH_REASONS) if (n(unauth[r])) out.github.unauthenticated[r] = n(unauth[r]);
  for (const [k, v] of Object.entries((g.unauthenticatedErrorStatuses ?? {}) as Record<string, unknown>).slice(0, MAX_STATUS_KEYS)) {
    if (/^\d{3}$/.test(k) && isErrorStatus(Number(k)) && n(v)) out.github.unauthenticatedErrorStatuses[k] = n(v);
  }
  for (const [k, v] of Object.entries((g.grantFetchFailures ?? {}) as Record<string, unknown>).slice(0, MAX_STATUS_KEYS)) {
    if (((/^\d{3}$/.test(k) && isErrorStatus(Number(k))) || k === 'error') && n(v)) out.github.grantFetchFailures[k] = n(v);
  }
  const rateLimit = normalizeRateLimit(g.rateLimit);
  if (rateLimit) out.github.rateLimit = rateLimit;
  return out;
}

export function applyEgressEvent(counters: EgressCounters, e: EgressEvent): void {
  const c = counters[e.cls];
  if (e.type === 'request') {
    c.requests += 1;
    if (e.rejected) c.rejected += 1;
  } else if (e.type === 'bytes') {
    c.responseBytes += Math.floor(e.bytes);
  }
}

/**
 * Wrap a response so `onDone(bytes)` fires once the body has been read to the
 * end (or failed). A body the container abandons is not reported, so
 * responseBytes is a lower bound. Status and headers are kept.
 */
/**
 * Count a response's bytes without putting large bodies through JavaScript.
 * Model responses (small, and their byte count matters) go through
 * countResponseBytes. GitHub and passthrough bodies are returned untouched so
 * they stream natively: a JS pass-through costs Worker CPU per chunk, and a
 * ~1.5 GB git pack exceeded the invocation's CPU limit, cutting the clone a
 * few KB before its end. Their bytes come from `content-length` when the
 * upstream sends one (a chunked git pack sends none, so it is not counted;
 * `responseBytes` stays a lower bound).
 */
export function measureResponse(res: Response, cls: EgressClass, onBytes: (bytes: number) => void): Response {
  if (cls === 'model') return countResponseBytes(res, onBytes);
  const len = Number(res.headers.get('content-length'));
  if (res.headers.has('content-length') && Number.isSafeInteger(len) && len >= 0) onBytes(len);
  return res;
}

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
  /** From a `BUILDD_WARM_UPLOAD=skipped` line. */
  warmUpload?: WarmUploadLine;
  /** From a `BUILDD_CACHE_SKIPPED=` line. */
  cacheSkipped?: CacheSkippedLine;
  /** A `task.scheduled` start: the time the wake was scheduled for. */
  scheduledFor?: number;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

export interface BrowserRunUsage {
  sessionMs: number;
  sessions: number;
  requests: number;
  bytes: number;
  relayErrors: number;
}

export interface RunReport {
  browser?: BrowserRunUsage & { provider: 'cloudflare'; sessionSeconds: number };
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
    /** Downloading and extracting the dependency cache of a warm restore (streamed). */
    restoreCache: number | null;
    /** A reused container: growing the clone from the packs the reset kept, fetch included (instead of `clone` / `restoreWarm`). */
    restoreReuse: number | null;
    toFirstModelRequest: number | null;
    total: number | null;
  };
  runnerPhases: RunnerPhases;
  /**
   * How the repo got onto the disk. `source` null: the runner printed no
   * source line (warm repos off, or no clone in this run). `reuse`: grown
   * from the packs a container reset kept.
   */
  repo: {
    source: 'warm' | 'clone' | 'reuse' | null;
    fallbackReason: RepoFallbackReason | null;
    snapshotAgeMs: number | null;
    /**
     * Why the run uploaded no warm snapshot it otherwise would have:
     * `too_large`, the repo (or its bundle as it streamed) was over the cap.
     * Null: uploaded, or no upload was due.
     */
    warmUploadSkipReason: WarmUploadSkipReason | null;
    /**
     * A part of the dependency cache the upload left out for size (the pnpm
     * store, or the whole cache tarball), its size on disk and the cap.
     * Null: nothing was left out, or no upload was due.
     */
    cacheSkipped: CacheSkippedLine | null;
    /**
     * `warmRepo`: the clone's object store as measured against the cap.
     * `cache`: the cache tarball as stored (zstd-compressed when the image
     * has zstd); `cacheRaw`: the same tarball before compression, on upload.
     */
    bytes: { clone: number | null; restore: number | null; fetch: number | null; cache: number | null; cacheRaw: number | null; upload: number | null; warmRepo: number | null };
  };
  /**
   * Resumable runs. `resumed`: this attempt continued a parked worker.
   * `gapMs`: from the end of the parked attempt to this dispatch (the answer
   * plus the webhook). `layer`: 1 = the transcript resumed, 2 = rebuilt from a
   * text reconstruction. `parkBytes`: the park bundle this attempt uploaded.
   */
  resume: { resumed: boolean; gapMs: number | null; layer: 1 | 2 | null; parkBytes: number | null };
  /**
   * A start from a `task.scheduled` wake. `scheduledFor`: the time buildd
   * asked for (the task's startAt). `startedAt`: when the attempt actually
   * started (= timestamps.dispatchReceivedAt). `lateMs`: the difference, null
   * when the attempt was not a scheduled start.
   */
  schedule: { scheduledFor: number | null; startedAt: number | null; lateMs: number | null };
  egress: EgressCounters;
  /** Why requests failed: refusal reasons and upstream error codes, per class. */
  egressDetail: EgressDetail;
  exitCode: number | null;
  outcome: RunOutcome | null;
  crashReport: CrashReport | null;
  /**
   * Set only when `outcome` is `deferred` or `start_deferred`: the backoff
   * retry the supervisor scheduled itself (or declined to, past the cap).
   * `reason`: the claim's taskExclusion/diagnostics code for `deferred`,
   * `'container_capacity'` for `start_deferred`, null if the runner printed
   * none. `retryNumber` is 1-indexed; `backoffMs` null means the cap
   * (MAX_DEFERRED_RETRIES) was hit and nothing was scheduled.
   */
  deferredRetry: { retryNumber: number; backoffMs: number | null; reason: string | null } | null;
  /**
   * What the run used of its container, from the runner's sampler
   * (apps/runner/src/resource-sampler.ts): the working-set peak and the
   * memory it was measured against, and the lowest free disk seen with the
   * disk's size. Null when the runner printed none (an older image).
   */
  resources: { memoryPeakBytes: number | null; memoryLimitBytes: number | null; diskFreeMinBytes: number | null; diskTotalBytes: number | null };
  /**
   * Why the run did not end on its own exit, when it did not:
   * `container_stopped` the container died under it (OOM, a platform stop);
   * `agent_restart` the agent restarted (a deploy) and found it orphaned;
   * `question` it parked waiting for an answer. buildd's size rule
   * (apps/web/src/lib/runner-size.ts) counts only the first.
   */
  interruption: RunInterruption | null;
  /**
   * Each time the agent (Durable Object) restarted while this attempt was
   * live, oldest first. `recovery`: `reattached` the runner was still going
   * and the new agent adopted it; `parked` it parked the run and resumed it;
   * `crashed` it could do neither. `versionChanged` true means a Worker
   * deploy; false means the restart had another cause (eviction, an isolate
   * limit); null when a version was unavailable.
   */
  agentRestarts: AgentRestart[];
  /**
   * The container class this attempt ran in and the decision that chose it
   * (buildd's runner size route; `source` null when none reached the agent).
   * `runnerSeconds`: container running to exit, rounded up;
   * `weightedRunnerSeconds` times the class weight (standard 1, large 2), for
   * hosted fair use. Nothing bills from it yet.
   */
  /**
   * Set when the attempt was handed a container an earlier run of the same
   * workspace and size left warm (container-lease.ts): which task's, how long
   * it sat idle, how long the reset took, and what reuse saved, measured:
   * this run's prep (prepMsOf: dispatch to claim, then getting the repo
   * ready) against the fresh-container baseline, the prep of the fresh run
   * that started the container. `savedMs` is negative when reuse was slower.
   * `fallback: 'reset_failed'`: the reset did not verify clean, so the
   * attempt started in a fresh container.
   */
  reusedContainer: ReusedContainer | null;
  /**
   * Who paid for this attempt's model calls: the deployer's own Claude token
   * on this Worker (`owner_seat`) or a metered route (gateway, proxy, team
   * endpoint or Anthropic key). Null when no model call went out. A label
   * only; the token itself is never in a report.
   */
  modelAuth: ModelAuth | null;
  runnerSize: {
    size: RunnerSize;
    source: RunnerSizeSource | null;
    reason: RunnerSizeReason | null;
    weight: number;
    runnerSeconds: number | null;
    weightedRunnerSeconds: number | null;
  };
}

export const RUN_INTERRUPTIONS = ['container_stopped', 'agent_restart', 'question'] as const;
export type RunInterruption = typeof RUN_INTERRUPTIONS[number];

export interface RunReportInput {
  browser?: BrowserRunUsage;
  taskId: string | null | undefined;
  attempt: number;
  workerId?: string | null;
  containerInstanceId?: string | null;
  instanceType?: string | null;
  dispatchReceivedAt?: number;
  timings?: RunTimings;
  egress?: EgressCounters;
  egressDetail?: EgressDetail;
  exitCode?: number | null;
  outcome?: RunOutcome;
  crashReport?: CrashReport;
  resumed?: boolean;
  /** End of the parked attempt this one resumes (agent clock). */
  parkedAt?: number;
  /** See RunReport.deferredRetry. */
  deferredRetry?: { retryNumber: number; backoffMs: number | null; reason: string | null } | null;
  /** See RunReport.interruption. */
  interruption?: RunInterruption | null;
  /** See RunReport.agentRestarts. */
  agentRestarts?: AgentRestart[];
  /** See RunReport.reusedContainer. */
  reusedContainer?: ReusedContainer | null;
  /** See RunReport.modelAuth. */
  modelAuth?: ModelAuth | null;
  /** The class this agent is (the container class actually used). Absent: standard. */
  runnerSize?: RunnerSize;
  /** buildd's decision that routed the dispatch here, if one reached the agent. */
  runnerSizeDecision?: RunnerSizeDecision | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INSTANCE_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OUTCOMES: readonly RunOutcome[] = ['done', 'failed', 'refused', 'usage', 'parked', 'deferred', 'start_deferred', 'crashed'];
const CRASH_REPORTS: readonly CrashReport[] = ['sent', 'rejected', 'error', 'no_worker_id'];
const AGENT_RECOVERIES: readonly AgentRestart['recovery'][] = ['reattached', 'parked', 'crashed'];
const DEFERRED_REASON_RE = /^[A-Za-z0-9_]{1,64}$/;

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

function msOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function reusedContainerSection(v: ReusedContainer | null | undefined, durationsMs: Partial<Record<string, number | null>>): ReusedContainer | null {
  const fromTaskId = id(v?.fromTaskId);
  if (!v || !fromTaskId) return null;
  const idleMs = count(v.idleMs);
  const resetMs = msOrNull(v.resetMs);
  if ('fallback' in v && v.fallback === 'reset_failed') return { fromTaskId, idleMs, fallback: 'reset_failed', resetMs };
  const baselinePrepMs = msOrNull('baselinePrepMs' in v ? v.baselinePrepMs : null);
  const prepMs = prepMsOf(durationsMs);
  return { fromTaskId, idleMs, resetMs, prepMs, baselinePrepMs, savedMs: prepMs !== null && baselinePrepMs !== null ? baselinePrepMs - prepMs : null };
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
  const source = src?.source === 'warm' || src?.source === 'clone' || src?.source === 'reuse' ? src.source : null;
  const fallbackReason = source === 'clone' && REPO_FALLBACK_REASONS.includes(src?.reason as RepoFallbackReason) ? src!.reason as RepoFallbackReason : null;
  const skipped = (t.warmUpload as { skipped?: unknown } | undefined)?.skipped;
  const warmUploadSkipReason = WARM_UPLOAD_SKIP_REASONS.includes(skipped as WarmUploadSkipReason) ? skipped as WarmUploadSkipReason : null;
  const durationsMs: RunReport['durationsMs'] = {
    containerStart: span(timestamps.dispatchReceivedAt, timestamps.containerRunningAt),
    toClaim: span(timestamps.containerRunningAt, timestamps.claimedAt),
    clone: span(phase('clone_start'), phase('clone_end')),
    install: span(phase('install_start'), phase('install_end')),
    restoreWarm: span(phase('restore_warm_start'), phase('restore_warm_end')),
    fetch: span(phase('fetch_start'), phase('fetch_end')),
    warmUpload: span(phase('warm_upload_start'), phase('warm_upload_end')),
    park: span(phase('park_start'), phase('park_end')),
    restorePark: span(phase('restore_park_start'), phase('restore_park_end')),
    restoreCache: span(phase('restore_cache_start'), phase('restore_cache_end')),
    restoreReuse: span(phase('restore_reuse_start'), phase('restore_reuse_end')),
    toFirstModelRequest: span(timestamps.claimedAt, timestamps.firstModelRequestAt),
    total: span(timestamps.dispatchReceivedAt, timestamps.exitedAt),
  };
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
    durationsMs,
    ...(input.browser ? { browser: { provider: 'cloudflare' as const, sessionMs: count(input.browser.sessionMs), sessionSeconds: count(input.browser.sessionMs) / 1000, sessions: count(input.browser.sessions), requests: count(input.browser.requests), bytes: count(input.browser.bytes), relayErrors: count(input.browser.relayErrors) } } : {}),
    runnerPhases: phases,
    repo: {
      source,
      fallbackReason,
      snapshotAgeMs: metric('snapshot_age_ms'),
      warmUploadSkipReason,
      cacheSkipped: cacheSkipped(t.cacheSkipped),
      bytes: {
        clone: metric('clone_bytes'),
        restore: metric('restore_bytes'),
        fetch: metric('fetch_bytes'),
        cache: metric('cache_bytes'),
        cacheRaw: metric('cache_raw_bytes'),
        upload: metric('warm_upload_bytes'),
        warmRepo: metric('warm_repo_bytes'),
      },
    },
    resume: {
      resumed: input.resumed === true,
      gapMs: input.resumed === true ? span(ts(input.parkedAt), timestamps.dispatchReceivedAt) : null,
      layer: metric('resume_layer') === 1 ? 1 : metric('resume_layer') === 2 ? 2 : null,
      parkBytes: metric('park_bytes'),
    },
    schedule: {
      scheduledFor: ts(t.scheduledFor),
      startedAt: timestamps.dispatchReceivedAt,
      lateMs: span(ts(t.scheduledFor), timestamps.dispatchReceivedAt),
    },
    egress,
    egressDetail: normalizeEgressDetail(input.egressDetail),
    exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) ? input.exitCode : null,
    outcome: input.outcome && OUTCOMES.includes(input.outcome) ? input.outcome : null,
    crashReport: input.crashReport && CRASH_REPORTS.includes(input.crashReport) ? input.crashReport : null,
    deferredRetry: input.deferredRetry
      ? {
          retryNumber: count(input.deferredRetry.retryNumber),
          backoffMs: ts(input.deferredRetry.backoffMs),
          reason: typeof input.deferredRetry.reason === 'string' && DEFERRED_REASON_RE.test(input.deferredRetry.reason) ? input.deferredRetry.reason : null,
        }
      : null,
    resources: {
      memoryPeakBytes: metric('mem_peak_bytes'),
      memoryLimitBytes: metric('mem_limit_bytes'),
      diskFreeMinBytes: metric('disk_free_min_bytes'),
      diskTotalBytes: metric('disk_total_bytes'),
    },
    interruption: RUN_INTERRUPTIONS.includes(input.interruption as RunInterruption) ? input.interruption as RunInterruption : null,
    agentRestarts: (input.agentRestarts ?? []).slice(0, 5).flatMap((r): AgentRestart[] => {
      const at = ts(r?.at);
      if (at === null || !AGENT_RECOVERIES.includes(r.recovery)) return [];
      return [{
        at,
        recovery: r.recovery,
        containerRunning: r.containerRunning === true,
        runningForMs: ts(r.runningForMs),
        versionChanged: typeof r.versionChanged === 'boolean' ? r.versionChanged : null,
      }];
    }),
    reusedContainer: reusedContainerSection(input.reusedContainer, durationsMs),
    modelAuth: input.modelAuth === 'owner_seat' || input.modelAuth === 'metered' ? input.modelAuth : null,
    runnerSize: runnerSizeSection(input, timestamps),
  };
}

function runnerSizeSection(input: RunReportInput, t: { containerRunningAt: number | null; exitedAt: number | null }): RunReport['runnerSize'] {
  const size: RunnerSize = input.runnerSize === 'large' ? 'large' : 'standard';
  const decision = normalizeRunnerSizeDecision(input.runnerSizeDecision);
  const secs = runnerSeconds(size, t.containerRunningAt, t.exitedAt);
  return {
    size,
    source: decision?.source ?? null,
    reason: decision?.reason ?? null,
    weight: RUNNER_CLASSES[size].weight,
    runnerSeconds: secs?.seconds ?? null,
    weightedRunnerSeconds: secs?.weighted ?? null,
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
