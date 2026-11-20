/**
 * `buildd acp`: this machine's buildd runner as an ACP agent, so an ACP client
 * (T3 Code: Settings -> Providers -> Local ACP command) shows buildd workers as
 * threads you can follow, answer, steer, pause and stop.
 *
 * The bridge never runs an agent. The runner keeps doing that, with every
 * guarantee it already has (sandbox, budgets, MCP config, PR flow, reporting
 * to the buildd server). The bridge only reads the runner's worker state and
 * relays a person's actions through the runner's socket, the same way
 * `buildd top` does (top/client.ts, runner-socket.ts WORKER_ACTIONS).
 *
 * Session id = worker id. Threads are opened by importing a worker from
 * `session/list`. A turn lasts while the worker is `working`; it ends when the
 * worker finishes, fails or waits for you, and the reply you type next goes to
 * the right place (answer / message / follow-up, translate.ts replyRoute).
 */
import type { PublicWorker } from '../public-worker';
import {
  BRIDGE_COMMANDS,
  MessageCursor,
  isSettled,
  parseCommand,
  replyRoute,
  settledText,
  textUpdate,
  usageOf,
  type SessionUpdate,
} from './translate';

export type WorkerActionName = 'answer' | 'message' | 'pause' | 'stop' | 'followup';

/** What the bridge needs from the runner (runner-port.ts implements it over the socket). */
export interface RunnerPort {
  listWorkers(): Promise<PublicWorker[]>;
  act(workerId: string, action: WorkerActionName, message?: string): Promise<{ status: number; body: unknown }>;
  /** Called with each worker the runner broadcasts. Returns an unsubscribe. */
  subscribe(onWorker: (worker: PublicWorker) => void): () => void;
}

export interface BridgeDeps {
  runner: RunnerPort;
  notify(sessionId: string, update: SessionUpdate): void;
  /** The main checkout a worktree belongs to, or null when it is not a git worktree. */
  repoRootOf(path: string): Promise<string | null>;
  /**
   * Names a project folder answers to (its folder name, `origin`'s repo and
   * owner/repo), lowercase. A finished worker keeps no path, only its
   * workspace name, and the client's folder may be a path this machine cannot
   * open (a Windows client talking to a runner in WSL).
   */
  projectNamesOf(cwd: string): Promise<string[]>;
  version: string;
  /** How long a reply may go unanswered by the runner before the turn ends anyway. */
  settleGraceMs?: number;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PROTOCOL_VERSION = 1;

type StopReason = 'end_turn' | 'cancelled';

interface Session {
  workerId: string | null;
  cursor: MessageCursor;
  /** Set while a prompt turn is open; calling it ends the turn as cancelled. */
  cancelTurn?: () => void;
}

const NEW_THREAD_TEXT = [
  'This thread is not linked to a buildd task.',
  'buildd tasks start from buildd (dashboard, `buildd top`, or the queue). To open one here,',
  'go to Settings → Providers → buildd → List sessions, pick a project, and import the worker.',
].join('\n');

export class AcpBridge {
  private sessions = new Map<string, Session>();
  private grace: number;

  constructor(private deps: BridgeDeps) {
    this.grace = deps.settleGraceMs ?? 30_000;
  }

  async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'initialize': return this.initialize();
      case 'authenticate': return {};
      case 'session/new': return this.newSession();
      case 'session/list': return this.listSessions(params ?? {});
      case 'session/load': return this.loadSession(params ?? {});
      case 'session/prompt': return this.prompt(params ?? {});
      case 'session/cancel': this.cancel(params ?? {}); return null;
      default: throw new RpcError(METHOD_NOT_FOUND, `buildd acp does not support ${method}`);
    }
  }

  private initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {} },
      },
      authMethods: [],
      agentInfo: { name: 'buildd', title: 'buildd', version: this.deps.version },
    };
  }

  private newSession() {
    const sessionId = `new-${crypto.randomUUID()}`;
    this.sessions.set(sessionId, { workerId: null, cursor: new MessageCursor() });
    return { sessionId };
  }

  private async listSessions(params: { cwd?: string | null }) {
    const workers = await this.deps.runner.listWorkers();
    const wanted = params.cwd ? normalize(params.cwd) : null;
    let names: string[] | null = null;
    const sessions = [];
    for (const w of workers) {
      if (!w.id) continue;
      const where = w.worktreePath ?? w.sessionCwd ?? null;
      if (wanted) {
        const byPath = where !== null && (await this.belongsTo(where, wanted));
        if (!byPath) {
          names ??= (await this.deps.projectNamesOf(params.cwd!).catch(() => [])).map(n => n.toLowerCase());
          if (!w.workspaceName || !names.includes(w.workspaceName.toLowerCase())) continue;
        }
      }
      const cwd = params.cwd ?? where;
      if (!cwd) continue;
      sessions.push({
        sessionId: w.id,
        cwd,
        title: w.taskTitle ?? w.id,
        updatedAt: w.lastActivity ? new Date(w.lastActivity).toISOString() : null,
        _meta: { buildd: { taskId: w.taskId ?? null, status: w.status, workspace: w.workspaceName ?? null, worktree: where, branch: w.branch ?? null } },
      });
    }
    sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { sessions };
  }

  private async belongsTo(path: string, projectRoot: string): Promise<boolean> {
    const p = normalize(path);
    if (p === projectRoot || p.startsWith(`${projectRoot}/`)) return true;
    const root = await this.deps.repoRootOf(path).catch(() => null);
    return root !== null && normalize(root) === projectRoot;
  }

  private async loadSession(params: { sessionId?: string }) {
    const workerId = params.sessionId;
    if (!workerId) throw new RpcError(INVALID_PARAMS, 'sessionId required');
    const worker = await this.findWorker(workerId);
    if (!worker) throw new RpcError(INVALID_PARAMS, `worker ${workerId} is not on this runner`);
    const session: Session = { workerId, cursor: new MessageCursor() };
    this.sessions.set(workerId, session);
    for (const u of session.cursor.next(worker.messages, { live: false })) this.emit(workerId, u);
    this.emit(workerId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: BRIDGE_COMMANDS.map(c => ({ name: c.name, description: c.description })),
    });
    const line = settledText(worker);
    if (line && worker.status === 'waiting') this.emit(workerId, textUpdate(line));
    return {};
  }

  private async prompt(params: { sessionId?: string; prompt?: Array<{ type: string; text?: string }> }) {
    const sessionId = params.sessionId;
    if (!sessionId) throw new RpcError(INVALID_PARAMS, 'sessionId required');
    const session = this.sessions.get(sessionId) ?? this.adopt(sessionId);
    const text = (params.prompt ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();

    if (!session.workerId) {
      this.emit(sessionId, textUpdate(NEW_THREAD_TEXT));
      return { stopReason: 'end_turn' };
    }
    const workerId = session.workerId;
    const worker = await this.findWorker(workerId);
    if (!worker) {
      this.emit(sessionId, textUpdate('This worker is no longer on this runner.'));
      return { stopReason: 'end_turn' };
    }
    if (!session.cursor.started) {
      // Opened without a load (a client resuming its own thread): show only what is new.
      session.cursor.skip(worker.messages);
    }

    const command = parseCommand(text);
    if (command === 'pause' || command === 'stop') {
      const r = await this.deps.runner.act(workerId, command);
      this.emit(sessionId, textUpdate(r.status < 400 ? (command === 'pause' ? 'Pausing at the next safe point.' : 'Stopping the run.') : refusal(r)));
      return { stopReason: 'end_turn' };
    }
    if (!text) return { stopReason: 'end_turn' };

    let alreadyMoving = false;
    if (command !== 'watch') {
      const route = replyRoute(worker);
      const r = await this.deps.runner.act(workerId, route, text);
      if (r.status >= 400) {
        this.emit(sessionId, textUpdate(refusal(r)));
        return { stopReason: 'end_turn' };
      }
      alreadyMoving = route === 'message';
    }
    return this.follow(session, sessionId, worker, { watching: command === 'watch', alreadyMoving });
  }

  /** Stream the worker until it settles; resolve with the turn's stop reason. */
  private follow(
    session: Session,
    sessionId: string,
    initial: PublicWorker,
    opts: { watching: boolean; alreadyMoving: boolean },
  ): Promise<{ stopReason: StopReason; usage?: ReturnType<typeof usageOf> }> {
    return new Promise((resolve) => {
      let latest = initial;
      let moving = opts.alreadyMoving;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (stopReason: StopReason, note?: string) => {
        if (done) return;
        done = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        session.cancelTurn = undefined;
        for (const u of session.cursor.closeOpenTool()) this.emit(sessionId, u);
        const line = note ?? (stopReason === 'end_turn' ? settledText(latest) : null);
        if (line) this.emit(sessionId, textUpdate(line));
        const usage = usageOf(latest);
        resolve(usage ? { stopReason, usage } : { stopReason });
      };

      const onWorker = (w: PublicWorker) => {
        if (done || w.id !== session.workerId) return;
        latest = w;
        const updates = session.cursor.next(w.messages, { live: true });
        for (const u of updates) this.emit(sessionId, u);
        if (w.status === 'working' || updates.length > 0) moving = true;
        if (moving && isSettled(w.status)) finish('end_turn');
      };

      const unsubscribe = this.deps.runner.subscribe(onWorker);
      session.cancelTurn = () => {
        void this.deps.runner.act(session.workerId!, 'pause').catch(() => {});
        finish('cancelled', 'Pausing the run. Reply to resume it.');
      };

      if (opts.watching) {
        if (isSettled(initial.status)) finish('end_turn');
        else moving = true;
        return;
      }
      timer = setTimeout(() => {
        if (!moving) finish('end_turn', "The runner hasn't picked up your reply yet. It will still be delivered; use /watch to follow the run.");
      }, this.grace);
    });
  }

  private cancel(params: { sessionId?: string }) {
    const session = params.sessionId ? this.sessions.get(params.sessionId) : undefined;
    session?.cancelTurn?.();
  }

  /** A prompt for a session this process never loaded: the session id is the worker id. */
  private adopt(sessionId: string): Session {
    const session: Session = { workerId: sessionId.startsWith('new-') ? null : sessionId, cursor: new MessageCursor() };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async findWorker(workerId: string): Promise<PublicWorker | undefined> {
    const workers = await this.deps.runner.listWorkers();
    return workers.find(w => w.id === workerId);
  }

  private emit(sessionId: string, update: SessionUpdate) {
    this.deps.notify(sessionId, update);
  }
}

function refusal(r: { status: number; body: unknown }): string {
  const b = r.body as { error?: unknown; message?: unknown } | string | null;
  const reason = typeof b === 'string' ? b : (b && (typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : null));
  return `The runner refused that (${r.status})${reason ? `: ${reason}` : ''}.`;
}

function normalize(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(p) || process.platform === 'win32') p = p.toLowerCase();
  return p;
}
