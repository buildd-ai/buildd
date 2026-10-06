/**
 * Drives one task's run inside the WorkerAgent: start a fresh container,
 * exec `buildd-once --task <id>`, wait for the process to exit, record the
 * outcome, stop the container, and report a crash if the runner could not.
 *
 * Runtime-free on purpose: the container, state and keep-alive are passed in,
 * so Bun tests drive it with fakes. worker-agent.ts wires the real ones.
 *
 * Safety bounds (docs/design/cloudflare-sandbox-runner.md):
 *  - `dispatch()` is the only way a run starts. Nothing here polls or
 *    re-dispatches. A retry is buildd firing a new webhook. The one deferred
 *    start is buildd's too: a `task.scheduled` webhook asks for a single
 *    one-shot wake at the task's startAt (scheduleDispatch); when it fires it
 *    goes through `dispatch()` like any webhook, and a later `task.scheduled`
 *    replaces it rather than adding a second.
 *  - At most one live run: `decideDispatch` ignores a dispatch while a run is
 *    starting or running, and the check-and-set happens before any await.
 *  - One container per agent, fresh per attempt: a leftover container is
 *    destroyed before the next attempt starts.
 *  - Resumable runs (Phase 2): a run that exits 4 is `parked`, not crashed.
 *    Only a `task.resume` dispatch for that same worker continues it. The one
 *    run the agent starts by itself is the resume of a run it parked while
 *    recovering from its own restart (recoverOrphan), and the runner bounds
 *    parks per worker.
 */
import {
  appendTail,
  assertRunnerConfig,
  buildContainerEnv,
  EXIT_PARKED,
  EXIT_NOT_ATTACHABLE,
  attachOrphanCommand,
  crashReportAction,
  decideDispatch,
  deferredRetryBackoffMs,
  isContainerStartCapacityError,
  orphanParkCommand,
  isOrphanedRun,
  outcomeForExitCode,
  parseClaimDeferredLine,
  parseWorkerIdLine,
  runnerCommand,
  type AgentRestart,
  type ContainerEnvSource,
  type CrashReport,
  type DispatchRequest,
  type RunOutcome,
  type RunState,
} from './lifecycle';
import {
  REPORT_HISTORY_MAX,
  RUN_LABEL_NAME,
  applyEgressEvent,
  assembleRunReport,
  deliverRunReport,
  emptyEgressCounters,
  emptyEgressDetail,
  applyEgressDetail,
  type EgressDetail,
  isEgressEvent,
  parseMetricLine,
  parsePhaseLine,
  parseRepoSourceLine,
  parseWarmUploadLine,
  parseCacheSkippedLine,
  recordMetric,
  recordPhase,
  runLabel,
  type EgressCounters,
  type ReportDelivery,
  type RunTimings,
  type StoredRunReport,
} from './run-report';
import { otelContainerEnv, type OtelEnv } from './otel';
import type { RunInterruption } from './run-report';
import type { RunnerSize, RunnerSizeDecision } from './runner-class';

/** The slice of `ctx.container` (workers-types `Container`) the supervisor uses. */
export interface ContainerPort {
  readonly running: boolean;
  start(options: { env: Record<string, string>; enableInternet: boolean; labels?: Record<string, string> }): void;
  /**
   * `env` is the process's whole environment: on Cloudflare an exec'd process
   * does not inherit the env given to start() (Docker's exec does, so local
   * runs never showed it).
   */
  exec(cmd: string[], options?: { stdout?: 'pipe'; stderr?: 'pipe'; env?: Record<string, string> }): Promise<ProcessPort>;
  monitor(): Promise<void>;
  destroy(reason?: string): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
}

/** The slice of workers-types `ExecProcess` the supervisor uses. */
export interface ProcessPort {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
}

export interface SupervisorConfig extends ContainerEnvSource, OtelEnv {
  inactivityTimeoutMs: number;
  startTimeoutMs: number;
  /** For the run report: this class's container instance type (runner-class.ts instanceTypeFor). */
  instanceType?: string;
  /** The container class this agent is (WorkerAgent standard, WorkerAgentLarge large). Absent: standard. */
  runnerSize?: RunnerSize;
  /** For the run report: the Durable Object ID the container is bound to. */
  containerInstanceId?: string;
  /** This Worker version's id (version metadata), to tell a deploy from any other agent restart. */
  agentVersion?: string;
  /** RESUMABLE_RUNS on (and the binding present): park an orphaned running container on restart. */
  resumableRuns?: boolean;
}

export interface SupervisorDeps {
  taskId: string;
  getState(): RunState;
  setState(state: RunState): void;
  container: ContainerPort;
  config: SupervisorConfig;
  /** Agent#keepAliveWhile: hold the Durable Object in memory while `fn` runs. */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** ctx.waitUntil, so the run outlives the RPC call that started it. */
  waitUntil(promise: Promise<unknown>): void;
  /** Egress credential injection (WorkerAgent.installEgressHandlers). A failure fails the run before start. */
  installEgress(): Promise<void>;
  /**
   * Mint this run's per-task token (WorkerAgent.mintTaskToken). The container
   * gets only this token; the runner key in `config` stays with the agent.
   */
  mintTaskToken(): Promise<string>;
  /** The Agents SDK schedule API (Agent#schedule / #cancelSchedule), one-shot only. */
  scheduler: SchedulerPort;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

/** What a scheduled-dispatch alarm is created with and fires with. */
export interface ScheduledDispatchPayload {
  /** Epoch ms the wake is for: the task's startAt. */
  notBefore: number;
  /** See DispatchRequest.deferredRetry — carried through the alarm so the fire can pass it on. */
  deferredRetry?: boolean;
  /** buildd's class decision from the `task.scheduled` webhook, for the run it starts. */
  runnerSize?: RunnerSizeDecision;
}

/**
 * The slice of the Agents SDK schedule API the supervisor uses. worker-agent.ts
 * wires it to `this.schedule(new Date(at), 'runScheduledDispatch', payload)`
 * and `this.cancelSchedule(id)`; tests fake it.
 */
export interface SchedulerPort {
  /** Create a one-shot that calls back with `payload` at `at` (epoch ms). Returns its id. */
  scheduleAt(at: number, payload: ScheduledDispatchPayload): Promise<string>;
  cancel(id: string): Promise<void>;
}

export type DispatchResult =
  | { accepted: true; attempt: number }
  | { accepted: false; reason: 'already_live' | 'not_parked'; attempt: number; status: RunState['status'] };

/** Answer to a `task.scheduled` dispatch. A notBefore already past is dispatched at once. */
export type ScheduleDispatchResult =
  | { scheduled: true; scheduledFor: number; replaced: boolean }
  | ({ scheduled: false } & DispatchResult);

/** What a scheduled-dispatch alarm did when it fired. */
export type ScheduledFireResult =
  | ({ fired: true } & DispatchResult)
  | { fired: false; reason: 'superseded' };

const READY_POLL_MS = 250;
const OUTPUT_DRAIN_MS = 5_000;
const CRASH_REPORT_TIMEOUT_MS = 10_000;
/** How long the orphan park (kill the runner, bundle, upload, mark) may take. */
const ORPHAN_PARK_TIMEOUT_MS = 10 * 60 * 1000;

type Settled =
  | { kind: 'exit'; code: number }
  | { kind: 'exec_error'; error: unknown }
  | { kind: 'container_exited' }
  | { kind: 'container_error'; error: unknown };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TaskSupervisor {
  private live: Promise<void> | null = null;
  private tail: string[] = [];
  /** Egress counters for the live run. Memory only: one write at the end, not one per request. */
  private egress: EgressCounters = emptyEgressCounters();
  private egressDetail: EgressDetail = emptyEgressDetail();

  constructor(private readonly d: SupervisorDeps) {}

  get hasLiveRun(): boolean {
    return this.live !== null;
  }

  /** Stored state, plus the in-memory output tail while a run is live. */
  status(): RunState {
    const state = this.d.getState();
    return this.hasLiveRun ? { ...state, outputTail: [...this.tail] } : state;
  }

  /**
   * Start a run unless one is live. Returns as soon as the state says
   * `starting`; the run itself continues under keepAlive + waitUntil.
   */
  dispatch(request: DispatchRequest = {}): DispatchResult {
    const state = this.d.getState();
    const decision = decideDispatch(state, request);
    if (decision.action === 'ignore') {
      this.d.log(decision.reason === 'already_live'
        ? `[cloud-runner] task ${this.d.taskId}: duplicate dispatch ignored (attempt ${state.attempt} is ${state.status})`
        : `[cloud-runner] task ${this.d.taskId}: resume ignored (attempt ${state.attempt} did not park that worker)`);
      return { accepted: false, reason: decision.reason, attempt: state.attempt, status: state.status };
    }
    const resume = decision.resumeWorkerId;
    // Starting a run consumes a pending scheduled wake: the fresh state below
    // drops it, so a fire that still arrives finds no matching id and is a
    // no-op; cancel the alarm too, best effort.
    if (state.scheduleId) this.cancelSchedule(state.scheduleId);
    // Check-and-set with no await in between: a second dispatch arriving
    // while this one is still starting sees `starting` and is ignored.
    const history = [...(state.reportHistory ?? []), ...(state.report ? [state.report] : [])].slice(-REPORT_HISTORY_MAX);
    this.d.setState({
      taskId: this.d.taskId,
      attempt: decision.attempt,
      status: 'starting',
      startedAt: this.d.now(),
      ...(this.d.config.agentVersion ? { agentVersion: this.d.config.agentVersion } : {}),
      outputTail: [],
      timings: request.scheduledFor !== undefined ? { scheduledFor: request.scheduledFor } : {},
      ...(history.length ? { reportHistory: history } : {}),
      // Carried forward ONLY for the agent's own backoff retry of a deferred
      // attempt — any other dispatch (a real retry webhook, a resume, the
      // very first attempt) resets the streak to 0 by omitting this key.
      ...(request.deferredRetry ? { deferredRetryCount: state.deferredRetryCount ?? 0 } : {}),
      // buildd's class decision for the run report. The agent's own retries
      // and resumes carry none and keep the last one that reached it.
      ...((request.runnerSize ?? state.runnerSize) ? { runnerSize: request.runnerSize ?? state.runnerSize } : {}),
      // A resume continues the parked worker: its id is known up front (for
      // the snapshot scope and a crash report), and no claim line will come.
      ...(resume ? { workerId: resume, resumed: true, ...(state.endedAt !== undefined ? { parkedAt: state.endedAt } : {}) } : {}),
    });
    this.tail = [];
    this.egress = emptyEgressCounters();
    this.egressDetail = emptyEgressDetail();
    this.d.log(`[cloud-runner] task ${this.d.taskId}: starting attempt ${decision.attempt}${resume ? ` (resuming worker ${resume})` : ''}`);
    const run = this.d.keepAliveWhile(() => this.run(decision.attempt, resume))
      .catch(err => this.d.log(`[cloud-runner] task ${this.d.taskId}: supervisor error: ${describe(err)}`))
      .finally(() => { if (this.live === run) this.live = null; });
    this.live = run;
    this.d.waitUntil(run);
    return { accepted: true, attempt: decision.attempt };
  }

  /**
   * `task.scheduled`: start a run at `notBefore` (epoch ms) instead of now.
   * Stores one pending wake in state (shown by GET /tasks/:id) and one
   * one-shot alarm; a later call replaces both (last write wins). A live run
   * does not block this: the crash path requeues while the crashed run is
   * still finishing, and the wake fires after it has. A `notBefore` already
   * past is a dispatch now. Bounds on how far ahead are the caller's (http.ts).
   */
  async scheduleDispatch(notBefore: number, opts: { deferredRetry?: boolean; runnerSize?: RunnerSizeDecision } = {}): Promise<ScheduleDispatchResult> {
    const previous = this.d.getState().scheduleId;
    if (notBefore <= this.d.now()) {
      if (previous) {
        this.patch({ scheduledFor: undefined, scheduleId: undefined });
        this.cancelSchedule(previous);
      }
      return { scheduled: false, ...this.dispatch({ scheduledFor: notBefore, deferredRetry: opts.deferredRetry, runnerSize: opts.runnerSize }) };
    }
    const id = await this.d.scheduler.scheduleAt(notBefore, {
      notBefore,
      ...(opts.deferredRetry ? { deferredRetry: true } : {}),
      ...(opts.runnerSize ? { runnerSize: opts.runnerSize } : {}),
    });
    // Re-read after the await: whatever happened meanwhile, this wake is the latest.
    const replaced = this.d.getState().scheduleId;
    this.patch({ scheduledFor: notBefore, scheduleId: id });
    if (replaced && replaced !== id) this.cancelSchedule(replaced);
    this.d.log(`[cloud-runner] task ${this.d.taskId}: dispatch scheduled for ${new Date(notBefore).toISOString()}${replaced ? ' (replacing the earlier one)' : ''}`);
    return { scheduled: true, scheduledFor: notBefore, replaced: !!previous || !!replaced };
  }

  /**
   * The scheduled wake fired. Only the latest one counts: an id that is not
   * the pending one (replaced, or consumed by a dispatch that started a run
   * first) does nothing. Otherwise the wake is cleared and handed to
   * `dispatch()`, which ignores it while a run is live.
   */
  fireScheduledDispatch(payload: ScheduledDispatchPayload, scheduleId: string | undefined): ScheduledFireResult {
    const state = this.d.getState();
    if (!scheduleId || state.scheduleId !== scheduleId) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: stale scheduled dispatch ${scheduleId ?? '(no id)'} ignored`);
      return { fired: false, reason: 'superseded' };
    }
    const scheduledFor = state.scheduledFor ?? payload.notBefore;
    this.patch({ scheduledFor: undefined, scheduleId: undefined });
    return { fired: true, ...this.dispatch({ scheduledFor, deferredRetry: payload.deferredRetry, runnerSize: payload.runnerSize }) };
  }

  private cancelSchedule(id: string): void {
    this.d.waitUntil(this.d.scheduler.cancel(id).catch(err =>
      this.d.log(`[cloud-runner] task ${this.d.taskId}: cancelling schedule ${id} failed: ${describe(err)}`)));
  }

  /**
   * Called when the agent starts. A run marked live in storage with nothing in
   * memory means this agent instance replaced one that was running it (a
   * deploy, an eviction, an isolate reset). The container outlives the agent,
   * so when it is still up the runner in it is too:
   *  1. re-adopt it: exec `--attach-orphan`, which waits on that runner and
   *     exits with its code, and finish the run as if nothing happened;
   *  2. if it cannot be attached, park it and resume it (resumable runs);
   *  3. otherwise tear the container down and treat the run as crashed.
   * The restart is recorded on the run report either way.
   */
  async recoverOrphan(): Promise<void> {
    const state = this.d.getState();
    if (!isOrphanedRun(state, this.hasLiveRun)) return;
    const containerRunning = this.d.container.running;
    const restart: Omit<AgentRestart, 'recovery'> = {
      at: this.d.now(),
      containerRunning,
      runningForMs: state.startedAt !== undefined ? Math.max(0, this.d.now() - state.startedAt) : null,
      versionChanged: state.agentVersion && this.d.config.agentVersion ? state.agentVersion !== this.d.config.agentVersion : null,
    };
    if (state.workerId && containerRunning) {
      // Not awaited: this runs from onStart, under the runtime's
      // blockConcurrencyWhile, and the egress handler calls back into this
      // agent. The state stays `running` and `live` is set meanwhile, so a
      // dispatch is ignored as a duplicate.
      const workerId = state.workerId;
      const run = this.d.keepAliveWhile(() => this.reattachOrphan(workerId, state, restart))
        .catch(err => this.d.log(`[cloud-runner] task ${this.d.taskId}: orphan recovery error: ${describe(err)}`))
        .finally(() => { if (this.live === run) this.live = null; });
      this.live = run;
      this.d.waitUntil(run);
      return;
    }
    await this.crashOrphan(state, { ...restart, recovery: 'crashed' });
  }

  /** Re-adopt the runner still going in the container; fall back to park-and-resume, then to a crash. */
  private async reattachOrphan(workerId: string, state: RunState, restart: Omit<AgentRestart, 'recovery'>): Promise<void> {
    this.tail = [];
    this.egress = emptyEgressCounters();
    this.egressDetail = emptyEgressDetail();
    const c = this.d.container;
    let code: number | null = null;
    let error: string | undefined;
    let interruption: RunInterruption | undefined;
    let attached = false;
    try {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: agent restarted under attempt ${state.attempt}; container still running, re-attaching to worker ${workerId}`);
      // Fresh token and fresh egress, as for a park: the exec'd process
      // inherits nothing, and the interception belonged to the old agent.
      const attempt = state.attempt ?? 1;
      const env = {
        ...buildContainerEnv(this.d.config, await this.d.mintTaskToken()),
        ...otelContainerEnv(this.d.config, { taskId: this.d.taskId, attempt }),
      };
      await this.d.installEgress();
      const proc = await c.exec(attachOrphanCommand(this.d.taskId, workerId), { stdout: 'pipe', stderr: 'pipe', env });
      attached = true;
      const pumps = Promise.all([this.pump(proc.stdout), this.pump(proc.stderr)]);
      const exited = proc.exitCode.then(
        (exitCode): Settled => ({ kind: 'exit', code: exitCode }),
        (err): Settled => ({ kind: 'exec_error', error: err }),
      );
      const died = c.monitor().then(
        (): Settled => ({ kind: 'container_exited' }),
        (err): Settled => ({ kind: 'container_error', error: err }),
      );
      const settled = await Promise.race([exited, died]);
      await Promise.race([pumps, this.d.sleep(OUTPUT_DRAIN_MS)]);
      if (settled.kind === 'exit') code = settled.code;
      else if (settled.kind === 'exec_error') error = `runner process failed: ${describe(settled.error)}`;
      else if (settled.kind === 'container_error') error = `container failed: ${describe(settled.error)}`;
      else error = 'container stopped while the runner was running';
      if (settled.kind === 'container_exited' || settled.kind === 'container_error') interruption = 'container_stopped';
    } catch (err) {
      error = describe(err);
    }
    // The runner was not there to adopt (or the attach itself failed before
    // it could wait): park-and-resume if allowed, else the crash path.
    if (code === EXIT_NOT_ATTACHABLE || (!attached && c.running)) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: could not re-attach to worker ${workerId}${error ? ` (${error})` : ''}`);
      if (this.d.config.resumableRuns && c.running) return this.parkOrphanThenResume(workerId, state, restart);
      return this.crashOrphan(state, { ...restart, recovery: 'crashed' });
    }
    this.patch({ agentRestarts: [...(state.agentRestarts ?? []), { ...restart, recovery: 'reattached' }] });
    const outcome: RunOutcome = outcomeForExitCode(code);
    this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${state.attempt} exited code=${code ?? 'none'} outcome=${outcome} after re-attach${error ? ` (${error})` : ''}`);
    await this.finish({ code, outcome, error, interruption });
  }

  private async parkOrphanThenResume(workerId: string, state: RunState, restart: Omit<AgentRestart, 'recovery'>): Promise<void> {
    const parked = await this.d.keepAliveWhile(() => this.parkOrphan(workerId));
    if (!parked || !(await this.markParked(workerId))) return this.crashOrphan(state, { ...restart, recovery: 'crashed' });
    this.patch({ agentRestarts: [...(state.agentRestarts ?? []), { ...restart, recovery: 'parked' }] });
    await this.finish({ code: EXIT_PARKED, outcome: 'parked', interruption: 'agent_restart' });
    this.dispatch({ resumeWorkerId: workerId });
  }

  /**
   * POST /api/workers/[id]/park for an orphan park. The agent does this, not
   * the container: the container outlived its agent, and its route to buildd
   * may not have survived with it (under wrangler dev it does not).
   */
  private async markParked(workerId: string): Promise<boolean> {
    const { BUILDD_SERVER: server, BUILDD_API_KEY: apiKey } = this.d.config;
    if (!server || !apiKey) return false;
    try {
      const res = await this.d.fetch(`${server.replace(/\/+$/, '')}/api/workers/${encodeURIComponent(workerId)}/park`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(CRASH_REPORT_TIMEOUT_MS),
      });
      if (res.ok) return true;
      this.d.log(`[cloud-runner] task ${this.d.taskId}: park mark for worker ${workerId} returned ${res.status}`);
    } catch (err) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: park mark for worker ${workerId} failed: ${describe(err)}`);
    }
    return false;
  }

  private async crashOrphan(state: RunState, restart: AgentRestart): Promise<void> {
    this.patch({ agentRestarts: [...(state.agentRestarts ?? []), restart] });
    this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${state.attempt} was ${state.status} when the agent restarted; marking it crashed`);
    const error = 'The agent restarted during the run and could not re-attach to the runner process.';
    await this.finish({ code: null, outcome: 'crashed', error, interruption: 'agent_restart' });
  }

  /** Exec the orphan park in the still-running container. True only on a clean exit 4. */
  private async parkOrphan(workerId: string): Promise<boolean> {
    this.d.log(`[cloud-runner] task ${this.d.taskId}: container still running after an agent restart; parking worker ${workerId}`);
    try {
      // A fresh per-task token, minted first as on a normal start: the exec'd
      // process inherits nothing from the run's start(), and the runner key
      // never enters the container.
      const attempt = this.d.getState().attempt ?? 1;
      const env = {
        ...buildContainerEnv(this.d.config, await this.d.mintTaskToken()),
        ...otelContainerEnv(this.d.config, { taskId: this.d.taskId, attempt }),
      };
      // The interception belonged to the agent before the restart; the park
      // upload goes through the snapshot route, so this agent installs its own.
      await this.d.installEgress();
      const proc = await this.d.container.exec(orphanParkCommand(this.d.taskId, workerId), { stdout: 'pipe', stderr: 'pipe', env });
      const pumps = Promise.all([this.pump(proc.stdout), this.pump(proc.stderr)]);
      const code = await Promise.race([
        proc.exitCode,
        this.d.sleep(ORPHAN_PARK_TIMEOUT_MS).then(() => null),
      ]);
      await Promise.race([pumps, this.d.sleep(OUTPUT_DRAIN_MS)]);
      if (code !== EXIT_PARKED) {
        this.d.log(`[cloud-runner] task ${this.d.taskId}: orphan park ended with ${code ?? 'a timeout'}; treating the run as crashed`);
        return false;
      }
      return true;
    } catch (err) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: orphan park failed: ${describe(err)}`);
      return false;
    }
  }

  /**
   * From the egress handler (via the agent RPC): one request seen, or one
   * response body's size. Ignored unless a run is live, and anything that is
   * not exactly an EgressEvent is dropped.
   */
  recordEgress(event: unknown): void {
    if (!this.hasLiveRun || !isEgressEvent(event)) return;
    applyEgressEvent(this.egress, event);
    applyEgressDetail(this.egressDetail, event);
    if (event.type === 'request' && event.cls === 'model' && this.d.getState().timings?.firstModelRequestAt === undefined) {
      this.patchTimings({ firstModelRequestAt: event.at });
    }
  }

  private async run(attempt: number, resumeWorkerId?: string): Promise<void> {
    const c = this.d.container;
    let code: number | null = null;
    let error: string | undefined;
    let configError = false;
    let interruption: RunInterruption | undefined;
    let otelEnv: Record<string, string>;
    try {
      try {
        assertRunnerConfig(this.d.config);
        otelEnv = otelContainerEnv(this.d.config, { taskId: this.d.taskId, attempt });
      } catch (err) {
        configError = true;
        throw err;
      }
      if (c.running) await c.destroy('leftover container from a previous attempt');
      const env = { ...buildContainerEnv(this.d.config, await this.d.mintTaskToken()), ...otelEnv };
      await this.d.installEgress();
      c.start({ env, enableInternet: true, labels: { [RUN_LABEL_NAME]: runLabel(this.d.taskId, attempt) } });
      await c.setInactivityTimeout(this.d.config.inactivityTimeoutMs);
      await this.waitUntilRunning();
      this.patchTimings({ containerRunningAt: this.d.now() });

      const proc = await c.exec(runnerCommand(this.d.taskId, resumeWorkerId), { stdout: 'pipe', stderr: 'pipe', env });
      this.patch({ status: 'running' });
      this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${attempt} running`);

      const pumps = Promise.all([this.pump(proc.stdout), this.pump(proc.stderr)]);
      const exited = proc.exitCode.then(
        (exitCode): Settled => ({ kind: 'exit', code: exitCode }),
        (err): Settled => ({ kind: 'exec_error', error: err }),
      );
      // The main process is `sleep infinity`, so the container only stops on
      // its own when something killed it (OOM, platform stop).
      const died = c.monitor().then(
        (): Settled => ({ kind: 'container_exited' }),
        (err): Settled => ({ kind: 'container_error', error: err }),
      );
      const settled = await Promise.race([exited, died]);
      this.patchTimings({ exitedAt: this.d.now() });
      await Promise.race([pumps, this.d.sleep(OUTPUT_DRAIN_MS)]);

      if (settled.kind === 'exit') code = settled.code;
      else if (settled.kind === 'exec_error') error = `runner process failed: ${describe(settled.error)}`;
      else if (settled.kind === 'container_error') error = `container failed: ${describe(settled.error)}`;
      else error = 'container stopped while the runner was running';
      // The container itself went away under a live runner (OOM, a platform
      // stop): what buildd's size rule counts as a restart.
      if (settled.kind === 'container_exited' || settled.kind === 'container_error') interruption = 'container_stopped';
    } catch (err) {
      error = describe(err);
    }

    // A container-capacity refusal (the platform's own instance ceiling, not
    // ours) never got as far as an exit code — `code` stays null. Distinct
    // from every other `code === null` case (container died, exec failed):
    // those ARE infrastructure crashes worth a stale-worker retry if a worker
    // exists; this one never got that far, so there is nothing to mark and
    // retrying the exact same container is pointless. finish() backs off and
    // self-schedules instead of reporting a crash.
    const outcome: RunOutcome = configError
      ? 'usage'
      : (code === null && isContainerStartCapacityError(error))
        ? 'start_deferred'
        : outcomeForExitCode(code);
    this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${attempt} exited code=${code ?? 'none'} outcome=${outcome}${error ? ` (${error})` : ''}`);
    await this.finish({ code, outcome, error, interruption });
  }

  /**
   * Stop the container, report a crash if needed, and only then mark the run
   * `exited`. Until that last write the run still counts as live, so a
   * dispatch that arrives during cleanup is ignored instead of starting an
   * attempt whose state this cleanup would then overwrite.
   */
  private async finish(r: { code: number | null; outcome: RunOutcome; error?: string; interruption?: RunInterruption }): Promise<void> {
    if (this.d.getState().timings?.exitedAt === undefined) this.patchTimings({ exitedAt: this.d.now() });
    await this.stopContainer(r.outcome === 'crashed' ? 'run crashed' : r.outcome === 'parked' ? 'run parked' : 'run finished');
    const crashReport = await this.reportCrashIfNeeded(r);
    // An attempt that died before claiming (no worker) because the agent
    // restarted (a deploy or migration) has no worker for buildd's infra-retry
    // budget to requeue, and stale detection has nothing to find: requeue it
    // here like a deferral. With a worker, the crash report above already did.
    const restartedBeforeClaim = r.outcome === 'crashed' && r.interruption === 'agent_restart' && !this.d.getState().workerId;
    const deferredRetry = r.outcome === 'deferred' || r.outcome === 'start_deferred'
      ? this.scheduleDeferredRetry(r.outcome)
      : restartedBeforeClaim ? this.scheduleDeferredRetry('agent_restart') : null;
    const state = this.d.getState();
    const report = assembleRunReport({
      taskId: this.d.taskId,
      attempt: state.attempt,
      workerId: state.workerId,
      containerInstanceId: this.d.config.containerInstanceId,
      instanceType: this.d.config.instanceType,
      runnerSize: this.d.config.runnerSize,
      runnerSizeDecision: state.runnerSize,
      // A park the runner chose itself is a question waiting for an answer.
      interruption: r.interruption ?? (r.outcome === 'parked' ? 'question' : null),
      agentRestarts: state.agentRestarts,
      dispatchReceivedAt: state.startedAt,
      timings: state.timings,
      egress: this.egress,
      egressDetail: this.egressDetail,
      exitCode: r.code,
      outcome: r.outcome,
      crashReport,
      resumed: state.resumed,
      parkedAt: state.parkedAt,
      deferredRetry,
    });
    this.patch({
      status: 'exited',
      exitCode: r.code,
      outcome: r.outcome,
      endedAt: this.d.now(),
      ...(r.error ? { error: r.error } : {}),
      ...(crashReport ? { crashReport } : {}),
      ...(deferredRetry ? { deferredRetryCount: deferredRetry.retryNumber } : {}),
      outputTail: [...this.tail],
      report: { ...report, delivery: report.workerId ? 'pending' : 'no_worker_id' },
    });
    // After `exited`: the report never holds up the outcome, and a dispatch
    // that arrives meanwhile starts the next attempt as usual.
    if (!report.workerId) return;
    const delivery = await deliverRunReport(
      { fetch: this.d.fetch, sleep: this.d.sleep, log: (m) => this.d.log(`${m} (task ${this.d.taskId})`) },
      { server: this.d.config.BUILDD_SERVER, apiKey: this.d.config.BUILDD_API_KEY },
      report,
    );
    this.setDelivery(report.attempt, delivery);
  }

  /**
   * A `deferred` (claim refused for a temporary reason) or `start_deferred`
   * (the platform's own container-capacity ceiling) attempt: nothing else
   * will retry this task — the runner never created a worker, so there is no
   * worker for buildd's own infra-retry budget to act on. Self-schedule the
   * next attempt on the existing `task.scheduled` alarm with backoff, capped
   * at MAX_DEFERRED_RETRIES; past the cap, give up and leave the task to
   * buildd's own sweep or a freed-capacity wake instead of retrying forever.
   */
  private scheduleDeferredRetry(outcome: 'deferred' | 'start_deferred' | 'agent_restart'): { retryNumber: number; backoffMs: number | null; reason: string | null } {
    const retryNumber = (this.d.getState().deferredRetryCount ?? 0) + 1;
    const reason = outcome === 'start_deferred' ? 'container_capacity'
      : outcome === 'agent_restart' ? 'agent_restart'
      : this.d.getState().claimDeferredReason ?? null;
    const backoffMs = deferredRetryBackoffMs(retryNumber, reason);
    if (backoffMs === null) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: ${outcome} (${reason ?? 'unknown'}) — retries exhausted after ${retryNumber - 1}; leaving it to buildd's own sweep`);
      return { retryNumber, backoffMs: null, reason };
    }
    this.d.log(`[cloud-runner] task ${this.d.taskId}: ${outcome} (${reason ?? 'unknown'}) — retrying in ${Math.round(backoffMs / 1000)}s (attempt ${retryNumber})`);
    this.d.waitUntil(this.scheduleDispatch(this.d.now() + backoffMs, { deferredRetry: true }).catch(err =>
      this.d.log(`[cloud-runner] task ${this.d.taskId}: scheduling the deferred retry failed: ${describe(err)}`)));
    return { retryNumber, backoffMs, reason };
  }

  /** Record the delivery on the attempt's report, wherever it is by now. */
  private setDelivery(attempt: number, delivery: ReportDelivery): void {
    const state = this.d.getState();
    const mark = (rep: StoredRunReport): StoredRunReport => (rep.attempt === attempt ? { ...rep, delivery } : rep);
    if (state.report?.attempt === attempt) {
      this.patch({ report: mark(state.report) });
    } else if (state.reportHistory?.some(rep => rep.attempt === attempt)) {
      this.patch({ reportHistory: state.reportHistory.map(mark) });
    }
  }

  private patchTimings(update: Partial<RunTimings>): void {
    this.patch({ timings: { ...(this.d.getState().timings ?? {}), ...update } });
  }

  private async waitUntilRunning(): Promise<void> {
    const deadline = this.d.now() + this.d.config.startTimeoutMs;
    while (!this.d.container.running) {
      if (this.d.now() >= deadline) {
        throw new Error(`container did not start within ${Math.round(this.d.config.startTimeoutMs / 1000)}s`);
      }
      await this.d.sleep(READY_POLL_MS);
    }
  }

  /** Forward runner output to the Worker log, keep a short tail, catch the worker ID. */
  private async pump(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buf = '';
    const onLine = (line: string) => {
      if (!line) return;
      this.d.log(`[task ${this.d.taskId}] ${line}`);
      // The tail stays in memory (persisted once, at the end) so a chatty run
      // does not write storage per line. The worker ID is persisted at once:
      // a crash report after an eviction needs it.
      this.tail = appendTail(this.tail, line);
      const state = this.d.getState();
      if (!state.workerId) {
        const workerId = parseWorkerIdLine(line);
        if (workerId) {
          this.patch({ workerId, timings: { ...(state.timings ?? {}), claimedAt: this.d.now() } });
          return;
        }
      }
      const claimDeferredReason = parseClaimDeferredLine(line);
      if (claimDeferredReason) {
        this.patch({ claimDeferredReason });
        return;
      }
      const phase = parsePhaseLine(line);
      if (phase) {
        const runnerPhases = recordPhase(state.timings?.runnerPhases, phase.phase, phase.at);
        if (runnerPhases !== state.timings?.runnerPhases) this.patchTimings({ runnerPhases });
        return;
      }
      const metric = parseMetricLine(line);
      if (metric) {
        this.patchTimings({ runnerMetrics: recordMetric(state.timings?.runnerMetrics, metric.metric, metric.value) });
        return;
      }
      const source = parseRepoSourceLine(line);
      if (source) {
        this.patchTimings({ repoSource: source });
        return;
      }
      const warmUpload = parseWarmUploadLine(line);
      if (warmUpload) { this.patchTimings({ warmUpload }); return; }
      const cacheSkipped = parseCacheSkippedLine(line);
      if (cacheSkipped) this.patchTimings({ cacheSkipped });
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl).replace(/\r$/, ''));
          buf = buf.slice(nl + 1);
        }
      }
      buf += decoder.decode();
      if (buf) onLine(buf);
    } catch (err) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: output stream ended: ${describe(err)}`);
    }
  }

  private async stopContainer(reason: string): Promise<void> {
    try {
      if (this.d.container.running) await this.d.container.destroy(reason);
    } catch (err) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: destroy failed: ${describe(err)}`);
    }
  }

  /**
   * Best effort: after a crash, mark the worker failed so the task does not
   * sit in `running` until stale detection finds it. A 409 means the runner
   * (or someone) already moved the worker to a terminal state, which is fine.
   */
  private async reportCrashIfNeeded(r: { code: number | null; outcome: RunOutcome; error?: string }): Promise<CrashReport | undefined> {
    const state = this.d.getState();
    const action = crashReportAction(r.outcome, state.workerId);
    if (action === 'none') return undefined;
    if (action === 'skip_no_worker') {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: crashed before a worker ID was seen; leaving it to stale detection`);
      return 'no_worker_id';
    }
    const { BUILDD_SERVER: server, BUILDD_API_KEY: apiKey } = this.d.config;
    if (!server || !apiKey) return 'error';
    const detail = r.error ? `: ${r.error}` : '';
    const body = {
      status: 'failed',
      error: `Cloud runner: the container ended without the runner reporting (exit code ${r.code ?? 'none'}, attempt ${state.attempt})${detail}`.slice(0, 1000),
      // Only a `crashed` outcome reaches here (crashReportAction): the runner
      // process or its container died without reporting. That is the same fact
      // the runner's own boot reconciliation reports for a session its process
      // lost, so it carries the same structured flag. buildd then books it as
      // infra_failure and requeues it on the infra-retry budget (backoff,
      // infraRetryCount, infra_stalled at the cap) instead of failing the task.
      // The agent's own exits (failed, refused, usage, parked) never send this.
      crashReconciled: true,
    };
    try {
      const res = await this.d.fetch(`${server.replace(/\/+$/, '')}/api/workers/${encodeURIComponent(state.workerId!)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CRASH_REPORT_TIMEOUT_MS),
      });
      if (res.ok) return 'sent';
      this.d.log(`[cloud-runner] task ${this.d.taskId}: crash report returned ${res.status}`);
      return 'rejected';
    } catch (err) {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: crash report failed: ${describe(err)}`);
      return 'error';
    }
  }

  private patch(update: Partial<RunState>): void {
    this.d.setState({ ...this.d.getState(), ...update });
  }
}
