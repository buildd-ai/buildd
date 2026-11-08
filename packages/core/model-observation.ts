/**
 * Per-attempt model observations: what actually ran, under what configuration,
 * and how it ended. Spec: "Model performance measurement" (Living Spec).
 *
 * This EXTENDS `task_outcomes` (per task routing outcome), `experiments`
 * (arms and readout) and `runner_usage` (per-attempt hosted runner time): it
 * stores one row per worker attempt and reads correctness evidence from the
 * records others wrote (review feedback, CI, spec verdicts, PR merge). It is
 * not a second analytics system.
 *
 * Pure: sanitising, failure-origin classification, the unavailable-reason map
 * and the evidence merge are functions of their arguments. The I/O lives in
 * apps/web/src/lib/model-observation-store.ts.
 */

/** A closed label for how the model was reached. Never a URL, host or credential. */
export const ENDPOINT_KINDS = [
  'anthropic_api',
  'oauth_seat',
  'team_endpoint',
  'local_loopback',
  'cloud_egress',
  'runner_provider',
  'unknown',
] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

export const FAILURE_ORIGINS = ['none', 'model', 'platform', 'harness', 'unknown'] as const;
export type FailureOrigin = (typeof FAILURE_ORIGINS)[number];

export const TERMINAL_OUTCOMES = ['completed', 'failed', 'cancelled', 'unknown'] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/** Evidence the worker did not write. `null` = not (yet) recorded. */
export interface ObservationEvidence {
  reviewVerdict: 'approved' | 'changes_requested' | null;
  ciState: 'passed' | 'failed' | null;
  specVerdict: 'pass' | 'fail' | null;
  prOutcome: 'merged' | 'closed' | null;
  reworked: boolean;
}

export const EMPTY_EVIDENCE: ObservationEvidence = {
  reviewVerdict: null,
  ciState: null,
  specVerdict: null,
  prOutcome: null,
  reworked: false,
};

/** What a runner may say about an attempt's configuration. Every field optional. */
export interface ObservationDescriptor {
  endpointKind?: EndpointKind;
  modelVersion?: string;
  quantization?: string;
  contextWindow?: number;
  backend?: string;
  harnessVersion?: string;
  runtime?: { os?: string; arch?: string; gpu?: string; gpuMemoryMb?: number; cpuCount?: number };
  generationMs?: number;
  toolFailures?: number;
  peakVramMb?: number;
  vramSamples?: number;
  attempt?: number;
}

const MAX_TEXT = 80;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\//i;
const SECRETISH = /(\bsk-|\bghp_|\bgho_|\bbld_|\bxox[bap]-|\beyJ[A-Za-z0-9_-]{10,}|bearer\s|api[_-]?key|token=|password)/i;
const AUTHORITY = /[^\s/@]+:[^\s/@]*@/;

/**
 * A short descriptive string, or null. Anything carrying a URL, a userinfo
 * authority or a credential-looking token is dropped whole rather than
 * scrubbed: a half-redacted endpoint is still an endpoint.
 */
export function safeLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_TEXT) return null;
  if (URL_LIKE.test(s) || AUTHORITY.test(s) || SECRETISH.test(s)) return null;
  // Allow model-ish and hardware-ish labels only.
  if (!/^[\w .:+/@()\-,]+$/.test(s) || s.includes('@')) return null;
  return s;
}

function boundedInt(v: unknown, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return undefined;
  return Math.round(v);
}

export function isEndpointKind(v: unknown): v is EndpointKind {
  return typeof v === 'string' && (ENDPOINT_KINDS as readonly string[]).includes(v);
}

/** Whitelist a runner-reported descriptor. Unknown keys and unsafe strings vanish. */
export function sanitizeDescriptor(raw: unknown): ObservationDescriptor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ObservationDescriptor = {};
  if (isEndpointKind(r.endpointKind)) out.endpointKind = r.endpointKind;
  const modelVersion = safeLabel(r.modelVersion);
  if (modelVersion) out.modelVersion = modelVersion;
  const quantization = safeLabel(r.quantization);
  if (quantization) out.quantization = quantization;
  const ctx = boundedInt(r.contextWindow, 10_000_000);
  if (ctx !== undefined && ctx > 0) out.contextWindow = ctx;
  const backend = safeLabel(r.backend);
  if (backend) out.backend = backend;
  const harnessVersion = safeLabel(r.harnessVersion);
  if (harnessVersion) out.harnessVersion = harnessVersion;
  const gen = boundedInt(r.generationMs, 7 * 24 * 3600 * 1000);
  if (gen !== undefined && gen > 0) out.generationMs = gen;
  const tf = boundedInt(r.toolFailures, 1_000_000);
  if (tf !== undefined) out.toolFailures = tf;
  const vram = boundedInt(r.peakVramMb, 4_000_000);
  if (vram !== undefined && vram > 0) out.peakVramMb = vram;
  const vs = boundedInt(r.vramSamples, 100_000);
  if (vs !== undefined) out.vramSamples = vs;
  const attempt = boundedInt(r.attempt, 10_000);
  if (attempt !== undefined && attempt >= 1) out.attempt = attempt;
  if (r.runtime && typeof r.runtime === 'object' && !Array.isArray(r.runtime)) {
    const rt = r.runtime as Record<string, unknown>;
    const runtime: NonNullable<ObservationDescriptor['runtime']> = {};
    const os = safeLabel(rt.os); if (os) runtime.os = os;
    const arch = safeLabel(rt.arch); if (arch) runtime.arch = arch;
    const gpu = safeLabel(rt.gpu); if (gpu) runtime.gpu = gpu;
    const gm = boundedInt(rt.gpuMemoryMb, 4_000_000); if (gm !== undefined && gm > 0) runtime.gpuMemoryMb = gm;
    const cc = boundedInt(rt.cpuCount, 4096); if (cc !== undefined && cc > 0) runtime.cpuCount = cc;
    if (Object.keys(runtime).length > 0) out.runtime = runtime;
  }
  return out;
}

/** The endpoint kind from what the claim knows. A label only; the URL never leaves the runner. */
export function endpointKindFrom(input: {
  modelRoute?: string | null;
  localModel?: boolean;
}): EndpointKind {
  if (input.localModel) return 'local_loopback';
  switch (input.modelRoute) {
    case 'anthropic_api_key': return 'anthropic_api';
    case 'oauth_seat': return 'oauth_seat';
    case 'agent_endpoint': return 'team_endpoint';
    case 'cloud_egress': return 'cloud_egress';
    case 'runner_provider': return 'runner_provider';
    default: return 'unknown';
  }
}

/**
 * Who a failure belongs to. Auth, budget, infra, sandbox, refusal and runner
 * loss are the platform or harness, never the model; only a failure of the work
 * itself (`code_failure`, a gate refusing what the session shipped) counts
 * against the model. Anything unclassified stays `unknown`, not `model`.
 */
export function failureOriginOf(outcome: TerminalOutcome, exitCause: string | null | undefined): FailureOrigin {
  if (outcome === 'completed') return 'none';
  if (outcome === 'cancelled') return 'platform';
  switch (exitCause) {
    case 'code_failure':
    case 'output_unmet':
      return 'model';
    case 'budget_limited':
    case 'infra_failure':
    case 'auth_failure':
    case 'never_started':
    case 'reassigned':
    case 'server_refused':
    case 'task_cancelled':
      return 'platform';
    case 'silent_start':
    case 'sandbox_mount_gap':
    case 'condition_unmet':
    case 'needs_input':
      return 'harness';
    default:
      return 'unknown';
  }
}

export function terminalOutcomeOf(status: string | null | undefined): TerminalOutcome {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'cancelled' || status === 'superseded') return 'cancelled';
  return 'unknown';
}

/** The input to build one row, everything the server and the runner know. */
export interface ObservationInput {
  workerId: string;
  attempt?: number;
  taskId: string | null;
  workspaceId: string;
  teamId: string;
  chainId: string | null;
  parentWorkerId: string | null;
  resolvedModel: string | null;
  taskClass: string | null;
  modelRoute: string | null;
  localModel?: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
  retries: number;
  status: string | null;
  exitCause: string | null;
  costUsd: number | null;
  costBasis: string | null;
  /** True when the model has a known price; a local or unknown model is unpriced. */
  priced: boolean;
  descriptor: ObservationDescriptor;
}

export type UnavailableReasons = Record<string, string>;

export interface ObservationValues {
  workerId: string;
  attempt: number;
  taskId: string | null;
  workspaceId: string;
  teamId: string;
  chainId: string | null;
  parentWorkerId: string | null;
  resolvedModel: string | null;
  endpointKind: EndpointKind;
  modelVersion: string | null;
  quantization: string | null;
  contextWindow: number | null;
  backend: string | null;
  harnessVersion: string | null;
  runtime: ObservationDescriptor['runtime'] | null;
  taskClass: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  generationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  turns: number | null;
  retries: number;
  toolFailures: number | null;
  terminalOutcome: TerminalOutcome;
  exitCause: string | null;
  failureOrigin: FailureOrigin;
  peakVramMb: number | null;
  vramSamples: number | null;
  costUsd: number | null;
  costBasis: string | null;
  unavailable: UnavailableReasons;
}

/**
 * Build the row. A metric the attempt cannot supply is NULL and named in
 * `unavailable`; nothing is defaulted to 0. Throughput exists only when a
 * generation time and an output token count were both measured.
 */
export function buildObservation(input: ObservationInput): ObservationValues {
  const d = input.descriptor;
  const unavailable: UnavailableReasons = {};
  const need = <T,>(field: string, value: T | undefined | null, reason: string): T | null => {
    if (value === undefined || value === null) { unavailable[field] = reason; return null; }
    return value;
  };

  const outcome = terminalOutcomeOf(input.status);
  const model = need('resolvedModel', input.resolvedModel, 'runner did not report the model it ran');
  const modelVersion = need('modelVersion', d.modelVersion, 'endpoint does not expose a version or digest');
  const quantization = need('quantization', d.quantization, 'endpoint does not expose quantization');
  const contextWindow = need('contextWindow', d.contextWindow, 'context size was not configured explicitly');
  const backend = need('backend', d.backend, 'runner did not report its backend');
  const harnessVersion = need('harnessVersion', d.harnessVersion, 'runner did not report the harness version');
  const runtime = need('runtime', d.runtime, 'runner did not report a hardware descriptor');
  const generationMs = need('generationMs', d.generationMs, 'generation time was not measured');
  const inputTokens = need('inputTokens', input.inputTokens && input.inputTokens > 0 ? input.inputTokens : null, 'no token usage reported');
  const outputTokens = need('outputTokens', input.outputTokens && input.outputTokens > 0 ? input.outputTokens : null, 'no token usage reported');
  const toolFailures = need('toolFailures', d.toolFailures, 'runner did not count tool failures');
  const peakVramMb = need('peakVramMb', d.peakVramMb, 'no GPU sampler available on this runner');

  let tokensPerSecond: number | null = null;
  if (generationMs && outputTokens) {
    tokensPerSecond = Math.round((outputTokens / (generationMs / 1000)) * 100) / 100;
  } else {
    unavailable.tokensPerSecond = 'needs a measured generation time and output tokens';
  }

  // Cost is never 0 by default: unpriced is unknown, not free.
  let costUsd: number | null = null;
  if (!input.priced) {
    unavailable.costUsd = 'model is unpriced (local or unknown model)';
  } else if (input.costUsd === null || input.costUsd === undefined || !(input.costUsd > 0)) {
    unavailable.costUsd = 'no cost reported for this attempt';
  } else {
    costUsd = input.costUsd;
  }

  return {
    workerId: input.workerId,
    attempt: d.attempt ?? input.attempt ?? 1,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    chainId: input.chainId,
    parentWorkerId: input.parentWorkerId,
    resolvedModel: model,
    endpointKind: d.endpointKind ?? endpointKindFrom({ modelRoute: input.modelRoute, localModel: input.localModel }),
    modelVersion,
    quantization,
    contextWindow,
    backend,
    harnessVersion,
    runtime,
    taskClass: input.taskClass,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    generationMs,
    inputTokens,
    outputTokens,
    tokensPerSecond,
    turns: input.turns,
    retries: input.retries,
    toolFailures,
    terminalOutcome: outcome,
    exitCause: input.exitCause,
    failureOrigin: failureOriginOf(outcome, input.exitCause),
    peakVramMb,
    vramSamples: peakVramMb === null ? null : d.vramSamples ?? null,
    costUsd,
    costBasis: input.costBasis,
    unavailable,
  };
}

/** Merge one late record into the evidence; a field only moves when the new value is known. */
export function applyEvidence(prev: ObservationEvidence, patch: Partial<ObservationEvidence>): ObservationEvidence {
  const next = { ...prev };
  for (const k of ['reviewVerdict', 'ciState', 'specVerdict', 'prOutcome'] as const) {
    const v = patch[k];
    if (v !== undefined && v !== null) (next as Record<string, unknown>)[k] = v;
  }
  if (patch.reworked) next.reworked = true;
  return next;
}

export type Correctness = 'unknown' | 'supported' | 'contradicted';

/**
 * What the independent records say. The worker's own completion is NOT an
 * input: a completed attempt with no outside evidence is `unknown`.
 * Contradiction wins over support (a failed CI or a requested change is a
 * finding even if another record passed).
 */
export function correctnessOf(e: ObservationEvidence): Correctness {
  if (e.reviewVerdict === 'changes_requested' || e.ciState === 'failed' || e.specVerdict === 'fail' || e.reworked) {
    return 'contradicted';
  }
  if (e.prOutcome === 'closed') return 'contradicted';
  if (e.reviewVerdict === 'approved' || e.ciState === 'passed' || e.specVerdict === 'pass' || e.prOutcome === 'merged') {
    return 'supported';
  }
  return 'unknown';
}

/**
 * The previous attempt in a chain, given the chain's observations ordered by
 * start. A new attempt links to the latest one that began before it, so a
 * retry or fallback keeps the earlier model's row untouched.
 */
export function parentAttemptOf(
  prior: ReadonlyArray<{ workerId: string; startedAt: Date | null }>,
  self: { workerId: string; startedAt: Date | null },
): string | null {
  const cand = prior
    .filter((p) => p.workerId !== self.workerId)
    .filter((p) => !self.startedAt || !p.startedAt || p.startedAt <= self.startedAt)
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  return cand.length ? cand[cand.length - 1].workerId : null;
}

/** nvidia-smi: `--query-gpu=memory.used --format=csv,noheader,nounits`, one MiB value per GPU. */
export function parseNvidiaSmiMemory(output: string): number | null {
  let total = 0;
  let seen = false;
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!/^\d+$/.test(t)) return null;
    total += Number(t);
    seen = true;
  }
  return seen ? total : null;
}

/** Bounded sampling policy: the interval and sample count are capped so a run costs a fixed few spawns. */
export const VRAM_SAMPLING = { intervalMs: 15_000, maxSamples: 240 } as const;

export class PeakTracker {
  peak: number | null = null;
  samples = 0;
  record(mb: number | null): boolean {
    if (this.samples >= VRAM_SAMPLING.maxSamples) return false;
    this.samples++;
    if (mb !== null && (this.peak === null || mb > this.peak)) this.peak = mb;
    return true;
  }
}

/**
 * The columns a late record may set: only fields it actually carries. A known
 * value is never erased by an absent one. Null when the patch carries nothing.
 */
export function evidenceColumns(patch: Partial<ObservationEvidence>): Partial<ObservationEvidence> | null {
  const out: Partial<ObservationEvidence> = {};
  if (patch.reviewVerdict) out.reviewVerdict = patch.reviewVerdict;
  if (patch.ciState) out.ciState = patch.ciState;
  if (patch.specVerdict) out.specVerdict = patch.specVerdict;
  if (patch.prOutcome) out.prOutcome = patch.prOutcome;
  if (patch.reworked) out.reworked = true;
  return Object.keys(out).length ? out : null;
}
