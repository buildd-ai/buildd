/**
 * The runner's own check run for a cloud verification task, taken out of the
 * agent's reach.
 *
 * In the container the runner process and the agent it spawns share one task
 * token and one process environment, so buildd cannot tell evidence the
 * runner reports there from the agent's word, and counts every task-token
 * report as the agent's (apps/web/src/lib/verification-provenance.ts). This
 * Worker holds a runner key the container never sees. After the runner
 * process has exited, and before the container stops, the supervisor:
 *
 *  1. asks buildd (runner key + dispatch token) whether the run is a
 *     verification run and for its command (/api/runner/verification-run);
 *  2. execs that command in the task's checkout and takes the exit code from
 *     the platform's ExecProcess, not from anything printed in the container;
 *  3. PATCHes it as the worker's verification evidence on the runner key.
 *
 * The worker is terminal by then, so buildd takes the report on its late
 * runner evidence path, which records the verdict. Only a spec criterion
 * check or a mission `command` criterion gets a run. Never throws: a failure
 * leaves the agent-reported evidence, which records no verdict.
 *
 * Runtime-free (no `cloudflare:workers`, no `agents`).
 */
import { IMAGE_ENV } from './lifecycle';
import { DISPATCH_TOKEN_HEADER } from './outbound';
import type { ContainerPort } from './supervisor';

export const VERIFICATION_RUN_PATH = '/api/runner/verification-run';
/** Same as the runner's VERIFICATION_COMMAND_TIMEOUT_MS (apps/runner/src/runner-verification.ts). */
export const VERIFICATION_TIMEOUT_MS = 60_000;
/** Same as the runner's VERIFICATION_EXCERPT_BYTES. */
export const VERIFICATION_EXCERPT_BYTES = 4096;
const PLAN_TIMEOUT_MS = 10_000;
const REPORT_TIMEOUT_MS = 10_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface VerificationConfig {
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  DISPATCH_TOKEN?: string;
}

export interface VerificationPlan {
  command: string;
  iteration: number;
  workspaceId: string;
  /** A mission's criterion batch: every criterion of one target, each under its own limit. */
  batch?: BatchPlan;
}

/** Mirrors @buildd/shared criterion-batch (this Worker takes no workspace deps). */
export interface BatchPlan {
  headSha: string;
  checks: Array<{ criterionId: string; command: string; timeoutMs: number }>;
}
export const BATCH_CHECKOUT_FAILED_EXIT = 125;
export const BATCH_CHECKOUT_TIMEOUT_MS = 120_000;
const BATCH_MIN_TIMEOUT_MS = 30_000;
const BATCH_MAX_TIMEOUT_MS = 20 * 60_000;
const SHA40 = /^[0-9a-f]{40}$/;

function parseBatch(b: Record<string, unknown>): BatchPlan | null {
  if (b.kind !== 'criterion_batch' || typeof b.headSha !== 'string' || !SHA40.test(b.headSha) || !Array.isArray(b.checks) || !b.checks.length) return null;
  const checks: BatchPlan['checks'] = [];
  for (const c of b.checks as unknown[]) {
    const r = (c ?? {}) as Record<string, unknown>;
    if (typeof r.criterionId !== 'string' || typeof r.command !== 'string' || !r.command.trim()) return null;
    const t = typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? r.timeoutMs : BATCH_MIN_TIMEOUT_MS;
    checks.push({ criterionId: r.criterionId, command: r.command, timeoutMs: Math.min(BATCH_MAX_TIMEOUT_MS, Math.max(BATCH_MIN_TIMEOUT_MS, Math.round(t))) });
  }
  return { headSha: b.headSha, checks };
}

/** Same checkout the host runner does for a batch (@buildd/shared batchCheckoutCommand). */
export function batchCheckoutCommand(headSha: string): string {
  return `git fetch -q origin ${headSha} >/dev/null 2>&1; git checkout -q --detach ${headSha}`;
}

export type RunnerVerificationResult =
  | 'reported'      // evidence sent and accepted (2xx) or taken on a terminal worker (409)
  | 'not_needed'    // not a verification run, or buildd has no such route yet
  | 'no_checkout'   // the task's checkout is not in the container
  | 'skipped'       // no dispatch token or runner key in this Worker
  | 'error';

export function verificationRunRequest(cfg: VerificationConfig, taskId: string, workerId: string): { url: string; init: RequestInit } {
  if (!cfg.BUILDD_SERVER || !cfg.BUILDD_API_KEY || !cfg.DISPATCH_TOKEN) {
    throw new Error('BUILDD_SERVER, BUILDD_API_KEY and DISPATCH_TOKEN are needed to ask for a verification run');
  }
  return {
    url: `${cfg.BUILDD_SERVER.replace(/\/+$/, '')}${VERIFICATION_RUN_PATH}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.BUILDD_API_KEY}`,
        [DISPATCH_TOKEN_HEADER]: cfg.DISPATCH_TOKEN,
      },
      body: JSON.stringify({ taskId, workerId }),
    },
  };
}

/** buildd's answer when it asks for a run for exactly this task and worker; else null. */
export function parseVerificationRunResponse(body: unknown, taskId: string, workerId: string): VerificationPlan | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.taskId !== taskId || b.workerId !== workerId || b.run !== true) return null;
  if (typeof b.workspaceId !== 'string' || !ID_RE.test(b.workspaceId)) return null;
  const iteration = typeof b.iteration === 'number' && Number.isInteger(b.iteration) && b.iteration >= 0 ? b.iteration : 0;
  if (b.kind !== undefined) {
    const batch = parseBatch(b);
    return batch ? { command: batchCheckoutCommand(batch.headSha), iteration, workspaceId: b.workspaceId, batch } : null;
  }
  if (typeof b.command !== 'string' || !b.command.trim()) return null;
  return { command: b.command, iteration, workspaceId: b.workspaceId };
}

/**
 * Where `buildd --once` checked the workspace out: in a cloud container the
 * runner works in the isolated clone itself, no worktree (apps/runner
 * isolation-paths.ts isolatedWorkspacePath under BUILDD_HOME/once-workspaces).
 * Computed here from buildd's workspace id, never read from container output.
 */
export function checkoutPath(workspaceId: string): string {
  return `${IMAGE_ENV.BUILDD_HOME}/once-workspaces/${workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Path and command as positional args, so neither is spliced into the shell text. */
export function verificationExecCommand(cwd: string, command: string): string[] {
  return ['sh', '-c', 'cd -- "$1" && exec sh -c "$2"', 'buildd-verify', cwd, command];
}

/** The head of a stream, capped at `limit` UTF-8 bytes; the rest is drained and dropped. */
async function readHead(stream: ReadableStream<Uint8Array> | null, limit = VERIFICATION_EXCERPT_BYTES): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (kept < limit && value) {
        const part = value.subarray(0, limit - kept);
        chunks.push(part);
        kept += part.length;
      }
    }
  } catch {
    // The stream ended with the process; what was read stands.
  }
  const all = new Uint8Array(kept);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  return new TextDecoder().decode(all).replace(/�+$/, '');
}

/** The tail of a stream, capped at `limit` UTF-8 bytes: a test run prints its verdict last. */
async function readTail(stream: ReadableStream<Uint8Array> | null, limit = VERIFICATION_EXCERPT_BYTES): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  let kept = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const joined = new Uint8Array(kept.length + value.length);
      joined.set(kept); joined.set(value, kept.length);
      kept = joined.length > limit ? joined.subarray(joined.length - limit) : joined;
    }
  } catch {
    // The stream ended with the process; what was read stands.
  }
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  return new TextDecoder().decode(kept).replace(/^\uFFFD+/, '');
}

export interface VerificationDeps {
  fetch: typeof fetch;
  container: Pick<ContainerPort, 'exec'>;
  log(message: string): void;
  now(): number;
  /** Resolves after `ms`; the default is a real timer, cleared once the command exits. */
  timeout?(ms: number): { promise: Promise<void>; cancel(): void };
  timeoutMs?: number;
}

function realTimeout(ms: number): { promise: Promise<void>; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>(r => { handle = setTimeout(r, ms); });
  return { promise, cancel: () => { if (handle !== undefined) clearTimeout(handle); } };
}

/** Run the command in the container: the evidence the runner's own run would report. */
export async function runCheckCommand(
  deps: VerificationDeps,
  plan: VerificationPlan,
  workerId: string,
  opts: { tail?: boolean } = {},
): Promise<Record<string, unknown> | 'no_checkout'> {
  const cwd = checkoutPath(plan.workspaceId);
  const base = { workerId, iteration: plan.iteration, conditionType: 'command', command: plan.command };
  const env = { ...IMAGE_ENV, BUILDD_EXECUTOR: 'cloud' };
  const probe = await deps.container.exec(['test', '-d', cwd], { env });
  if ((await probe.exitCode) !== 0) return 'no_checkout';

  const start = deps.now();
  let proc;
  try {
    proc = await deps.container.exec(verificationExecCommand(cwd, plan.command), { stdout: 'pipe', stderr: 'pipe', env });
  } catch (err) {
    return { ...base, durationMs: deps.now() - start, stderr: String(err instanceof Error ? err.message : err).slice(0, VERIFICATION_EXCERPT_BYTES), outcome: 'exec_error' };
  }
  const read = opts.tail ? readTail : readHead;
  const out = Promise.all([read(proc.stdout), read(proc.stderr)]);
  const timer = (deps.timeout ?? realTimeout)(deps.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
  const settled = await Promise.race([
    proc.exitCode.then((code): { code: number } | { error: unknown } => ({ code }), (error: unknown) => ({ error })),
    timer.promise.then(() => 'timeout' as const),
  ]);
  timer.cancel();
  const durationMs = deps.now() - start;
  if (settled === 'timeout') return { ...base, durationMs, outcome: 'timeout' };
  if ('error' in settled) {
    return { ...base, durationMs, stderr: String(settled.error instanceof Error ? settled.error.message : settled.error).slice(0, VERIFICATION_EXCERPT_BYTES), outcome: 'exec_error' };
  }
  const [stdout, stderr] = await out;
  return { ...base, exitCode: settled.code, durationMs, stdout, stderr, outcome: settled.code === 0 ? 'ok' : 'failed' };
}

/**
 * A mission's criterion batch: one checkout, then each criterion's command
 * under its own limit, as the host runner does (apps/runner/src/criterion-batch.ts).
 */
export async function runCheckBatch(
  deps: VerificationDeps,
  plan: VerificationPlan & { batch: BatchPlan },
  workerId: string,
): Promise<Record<string, unknown> | 'no_checkout'> {
  const { batch } = plan;
  const checkout = await runCheckCommand({ ...deps, timeoutMs: BATCH_CHECKOUT_TIMEOUT_MS }, { ...plan, command: batchCheckoutCommand(batch.headSha) }, workerId, { tail: true });
  if (checkout === 'no_checkout') return 'no_checkout';
  const base = { conditionType: 'criterion_batch', workerId, headSha: batch.headSha };
  if (checkout.outcome !== 'ok') {
    return {
      ...base, checkout: 'failed',
      results: batch.checks.map((c) => ({ criterionId: c.criterionId, command: c.command, outcome: 'failed', exitCode: BATCH_CHECKOUT_FAILED_EXIT, durationMs: 0 })),
    };
  }
  const results: Array<Record<string, unknown>> = [];
  for (const c of batch.checks) {
    const r = await runCheckCommand({ ...deps, timeoutMs: c.timeoutMs }, { ...plan, command: c.command }, workerId, { tail: true });
    if (r === 'no_checkout') return 'no_checkout';
    const { workerId: _w, iteration: _i, conditionType: _c, command: _cmd, ...rest } = r;
    results.push({ criterionId: c.criterionId, command: c.command, timeoutMs: c.timeoutMs, ...rest });
  }
  return { ...base, checkout: 'ok', results };
}

/** Steps 1 to 3 above. Never throws. */
export async function runRunnerVerification(
  deps: VerificationDeps,
  cfg: VerificationConfig,
  taskId: string,
  workerId: string,
): Promise<RunnerVerificationResult> {
  if (!cfg.BUILDD_SERVER || !cfg.BUILDD_API_KEY || !cfg.DISPATCH_TOKEN) return 'skipped';
  const tag = `[cloud-runner] task ${taskId}: verification run`;
  try {
    const { url, init } = verificationRunRequest(cfg, taskId, workerId);
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(PLAN_TIMEOUT_MS) });
    // 404: an older buildd without the route, or not this account's cloud worker.
    if (!res.ok) {
      deps.log(`${tag} lookup returned ${res.status}`);
      return res.status === 404 ? 'not_needed' : 'error';
    }
    const plan = parseVerificationRunResponse(await res.json(), taskId, workerId);
    if (!plan) return 'not_needed';

    const evidence = plan.batch ? await runCheckBatch(deps, { ...plan, batch: plan.batch }, workerId) : await runCheckCommand(deps, plan, workerId);
    if (evidence === 'no_checkout') {
      deps.log(`${tag}: no checkout for workspace ${plan.workspaceId}; nothing reported`);
      return 'no_checkout';
    }
    deps.log(`${tag}: outcome=${String(evidence.outcome)} exitCode=${String(evidence.exitCode ?? 'none')} durationMs=${String(evidence.durationMs)}`);

    const report = await deps.fetch(`${cfg.BUILDD_SERVER.replace(/\/+$/, '')}/api/workers/${encodeURIComponent(workerId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.BUILDD_API_KEY}` },
      body: JSON.stringify({ verificationEvidence: evidence }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    // 409: the worker is terminal; buildd still takes the evidence on its late runner path.
    if (report.ok || report.status === 409) return 'reported';
    deps.log(`${tag}: report returned ${report.status}`);
    return 'error';
  } catch (err) {
    deps.log(`${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}
