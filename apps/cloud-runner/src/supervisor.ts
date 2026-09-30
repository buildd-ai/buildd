/**
 * Drives one task's run inside the WorkerAgent: start a fresh container,
 * exec `buildd-once --task <id>`, wait for the process to exit, record the
 * outcome, stop the container, and report a crash if the runner could not.
 *
 * Runtime-free on purpose: the container, state and keep-alive are passed in,
 * so Bun tests drive it with fakes. worker-agent.ts wires the real ones.
 *
 * Safety bounds (docs/design/cloudflare-sandbox-runner.md):
 *  - `dispatch()` is the only way a run starts. Nothing here schedules,
 *    polls or re-dispatches. A retry is buildd firing a new webhook.
 *  - At most one live run: `decideDispatch` ignores a dispatch while a run is
 *    starting or running, and the check-and-set happens before any await.
 *  - One container per agent, fresh per attempt: a leftover container is
 *    destroyed before the next attempt starts.
 */
import {
  appendTail,
  assertRunnerConfig,
  buildContainerEnv,
  crashReportAction,
  decideDispatch,
  isOrphanedRun,
  outcomeForExitCode,
  parseWorkerIdLine,
  runnerCommand,
  type ContainerEnvSource,
  type CrashReport,
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
  isEgressEvent,
  parsePhaseLine,
  recordPhase,
  runLabel,
  type EgressCounters,
  type ReportDelivery,
  type RunTimings,
  type StoredRunReport,
} from './run-report';

/** The slice of `ctx.container` (workers-types `Container`) the supervisor uses. */
export interface ContainerPort {
  readonly running: boolean;
  start(options: { env: Record<string, string>; enableInternet: boolean; labels?: Record<string, string> }): void;
  exec(cmd: string[], options?: { stdout?: 'pipe'; stderr?: 'pipe' }): Promise<ProcessPort>;
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

export interface SupervisorConfig extends ContainerEnvSource {
  inactivityTimeoutMs: number;
  startTimeoutMs: number;
  /** For the run report: the configured container instance type (CONTAINER_INSTANCE_TYPE). */
  instanceType?: string;
  /** For the run report: the Durable Object ID the container is bound to. */
  containerInstanceId?: string;
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
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export type DispatchResult =
  | { accepted: true; attempt: number }
  | { accepted: false; reason: 'already_live'; attempt: number; status: RunState['status'] };

const READY_POLL_MS = 250;
const OUTPUT_DRAIN_MS = 5_000;
const CRASH_REPORT_TIMEOUT_MS = 10_000;

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
  dispatch(): DispatchResult {
    const state = this.d.getState();
    const decision = decideDispatch(state);
    if (decision.action === 'ignore') {
      this.d.log(`[cloud-runner] task ${this.d.taskId}: duplicate dispatch ignored (attempt ${state.attempt} is ${state.status})`);
      return { accepted: false, reason: decision.reason, attempt: state.attempt, status: state.status };
    }
    // Check-and-set with no await in between: a second dispatch arriving
    // while this one is still starting sees `starting` and is ignored.
    const history = [...(state.reportHistory ?? []), ...(state.report ? [state.report] : [])].slice(-REPORT_HISTORY_MAX);
    this.d.setState({
      taskId: this.d.taskId,
      attempt: decision.attempt,
      status: 'starting',
      startedAt: this.d.now(),
      outputTail: [],
      timings: {},
      ...(history.length ? { reportHistory: history } : {}),
    });
    this.tail = [];
    this.egress = emptyEgressCounters();
    this.d.log(`[cloud-runner] task ${this.d.taskId}: starting attempt ${decision.attempt}`);
    const run = this.d.keepAliveWhile(() => this.run(decision.attempt))
      .catch(err => this.d.log(`[cloud-runner] task ${this.d.taskId}: supervisor error: ${describe(err)}`))
      .finally(() => { if (this.live === run) this.live = null; });
    this.live = run;
    this.d.waitUntil(run);
    return { accepted: true, attempt: decision.attempt };
  }

  /**
   * Called when the agent starts. A run marked live in storage with nothing in
   * memory was lost to an eviction or restart; its process cannot be
   * re-attached, so tear the container down and treat the run as crashed.
   */
  async recoverOrphan(): Promise<void> {
    const state = this.d.getState();
    if (!isOrphanedRun(state, this.hasLiveRun)) return;
    this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${state.attempt} was ${state.status} when the agent restarted; marking it crashed`);
    const error = 'The agent restarted during the run and could not re-attach to the runner process.';
    await this.finish({ code: null, outcome: 'crashed', error });
  }

  /**
   * From the egress handler (via the agent RPC): one request seen, or one
   * response body's size. Ignored unless a run is live, and anything that is
   * not exactly an EgressEvent is dropped.
   */
  recordEgress(event: unknown): void {
    if (!this.hasLiveRun || !isEgressEvent(event)) return;
    applyEgressEvent(this.egress, event);
    if (event.type === 'request' && event.cls === 'model' && this.d.getState().timings?.firstModelRequestAt === undefined) {
      this.patchTimings({ firstModelRequestAt: event.at });
    }
  }

  private async run(attempt: number): Promise<void> {
    const c = this.d.container;
    let code: number | null = null;
    let error: string | undefined;
    let configError = false;
    try {
      try {
        assertRunnerConfig(this.d.config);
      } catch (err) {
        configError = true;
        throw err;
      }
      if (c.running) await c.destroy('leftover container from a previous attempt');
      const env = buildContainerEnv(this.d.config, await this.d.mintTaskToken());
      await this.d.installEgress();
      c.start({ env, enableInternet: true, labels: { [RUN_LABEL_NAME]: runLabel(this.d.taskId, attempt) } });
      await c.setInactivityTimeout(this.d.config.inactivityTimeoutMs);
      await this.waitUntilRunning();
      this.patchTimings({ containerRunningAt: this.d.now() });

      const proc = await c.exec(runnerCommand(this.d.taskId), { stdout: 'pipe', stderr: 'pipe' });
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
    } catch (err) {
      error = describe(err);
    }

    const outcome = configError ? 'usage' : outcomeForExitCode(code);
    this.d.log(`[cloud-runner] task ${this.d.taskId}: attempt ${attempt} exited code=${code ?? 'none'} outcome=${outcome}${error ? ` (${error})` : ''}`);
    await this.finish({ code, outcome, error });
  }

  /**
   * Stop the container, report a crash if needed, and only then mark the run
   * `exited`. Until that last write the run still counts as live, so a
   * dispatch that arrives during cleanup is ignored instead of starting an
   * attempt whose state this cleanup would then overwrite.
   */
  private async finish(r: { code: number | null; outcome: RunOutcome; error?: string }): Promise<void> {
    if (this.d.getState().timings?.exitedAt === undefined) this.patchTimings({ exitedAt: this.d.now() });
    await this.stopContainer(r.outcome === 'crashed' ? 'run crashed' : 'run finished');
    const crashReport = await this.reportCrashIfNeeded(r);
    const state = this.d.getState();
    const report = assembleRunReport({
      taskId: this.d.taskId,
      attempt: state.attempt,
      workerId: state.workerId,
      containerInstanceId: this.d.config.containerInstanceId,
      instanceType: this.d.config.instanceType,
      dispatchReceivedAt: state.startedAt,
      timings: state.timings,
      egress: this.egress,
      exitCode: r.code,
      outcome: r.outcome,
      crashReport,
    });
    this.patch({
      status: 'exited',
      exitCode: r.code,
      outcome: r.outcome,
      endedAt: this.d.now(),
      ...(r.error ? { error: r.error } : {}),
      ...(crashReport ? { crashReport } : {}),
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
      const phase = parsePhaseLine(line);
      if (phase) {
        const runnerPhases = recordPhase(state.timings?.runnerPhases, phase.phase, phase.at);
        if (runnerPhases !== state.timings?.runnerPhases) this.patchTimings({ runnerPhases });
      }
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
