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
  waitKey,
  waitingForm,
  type SessionUpdate,
} from './translate';

const ATTEMPT_LABEL = { ci: 'CI fix', reviewer: 'review', conflict: 'conflict fix' } as const;

export type WorkerActionName = 'answer' | 'message' | 'pause' | 'stop' | 'followup';

/** What the bridge needs from the runner (runner-port.ts implements it over the socket). */
export interface RunnerPort {
  listWorkers(): Promise<PublicWorker[]>;
  act(workerId: string, action: WorkerActionName, message?: string): Promise<{ status: number; body: unknown }>;
  /**
   * Called with each worker the runner broadcasts. Returns an unsubscribe.
   * `onSnapshot` gets the ids of every worker in a full list the runner sends
   * (the init frame on each (re)connect), so a turn can tell its worker is gone.
   */
  subscribe(onWorker: (worker: PublicWorker) => void, onSnapshot?: (ids: Set<string>) => void): () => void;
  /** The workspaces this runner's key reaches (`GET /api/workspaces`). */
  listWorkspaces(): Promise<BuilddWorkspace[]>;
  createTask(input:   { workspaceId: string; title: string; description: string; reserve?: boolean; context?: Record<string, unknown> } & BuilddTaskMeta): Promise<{ status: number; body: unknown }>;
  /** Claim a task onto this runner as a person would (`c` in top). */
  claim(taskId: string): Promise<{ status: number; body: unknown }>;
}

/** `_meta.buildd` on `session/new` or the first `session/prompt`: where the thread's task is filed. */
export interface BuilddTaskMeta {
  missionId?: string;
  roleSlug?: string;
  priority?: number;
  kind?: string;
}

function taskMetaFrom(params: unknown): BuilddTaskMeta {
  const raw = (params as { _meta?: { buildd?: Record<string, unknown> } } | null)?._meta?.buildd;
  if (!raw || typeof raw !== 'object') return {};
  const out: BuilddTaskMeta = {};
  if (typeof raw.missionId === 'string' && raw.missionId) out.missionId = raw.missionId;
  if (typeof raw.roleSlug === 'string' && raw.roleSlug) out.roleSlug = raw.roleSlug;
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) out.priority = raw.priority;
  if (typeof raw.kind === 'string' && raw.kind) out.kind = raw.kind;
  return out;
}

export interface BuilddWorkspace {
  id: string;
  name: string;
  repo?: string | null;
  teamName?: string | null;
}

/**
 * Which worker a client thread is. A thread opened from `session/list` is
 * named by its worker id; a thread the client started (`session/new`) has an
 * id of ours and is linked to the worker its first message created. The link
 * must outlive this process: a client restarts its agent freely, and a
 * forgotten link would turn a resent message into a second task.
 */
export interface SessionLinks {
  get(sessionId: string): string | null;
  set(sessionId: string, workerId: string): void;
  /** The client thread a worker was started from, if any. */
  sessionFor?(workerId: string): string | null;
}

export interface BridgeDeps {
  runner: RunnerPort;
  links: SessionLinks;
  notify(sessionId: string, update: SessionUpdate): void;
  /** Send a request to the client and await its result (ACP `elicitation/create`). */
  request?(method: string, params: unknown): Promise<any>;
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
  /** The client's project folder: where a first message's task goes. */
  cwd: string | null;
  cursor: MessageCursor;
  /** `_meta.buildd` the client gave this thread; passed to createTask. */
  taskMeta?: BuilddTaskMeta;
  /** Set while a prompt turn is open; calling it ends the turn as cancelled. */
  cancelTurn?: () => void;
}

const NEW_THREAD_TEXT = [
  'This thread has no buildd task yet. Describe the work and send it: that becomes a buildd task',
  'in this project, run on this machine. To open an existing one instead, use',
  'Settings → Providers → buildd → List sessions.',
].join('\n');

const TITLE_MAX = 120;

/** Blocks T3 Code adds around a message for an agent running inside T3: its tool rules, runtime notes, PR-linking rules. */
const CLIENT_ENVELOPE_BLOCKS = /<(t3_code_instructions|runtime_info|pull_request_linking)>[\s\S]*?<\/\1>/g;

/**
 * What the user typed. T3 Code sends `<user_request>…</user_request>` inside an
 * envelope of instructions meant for an agent that has T3's tools; a buildd
 * worker has none of them, and the envelope's first line became the task
 * title. Without the user_request wrapper, the envelope blocks are dropped and
 * the rest is kept, so any other client's text passes through unchanged.
 */
export function userTextFrom(text: string): string {
  const request = /<user_request>([\s\S]*?)<\/user_request>/.exec(text);
  if (request) return request[1].trim();
  return text.replace(CLIENT_ENVELOPE_BLOCKS, '').trim();
}

/** First non-empty line, clipped: what the dashboard and queue show for the task. */
export function taskTitleFrom(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? text.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export class AcpBridge {
  private sessions = new Map<string, Session>();
  private grace: number;
  /** The client renders ACP form elicitations (T3 Code shows them as its own question UI). */
  private canElicit = false;
  /** The client's own name from `initialize` clientInfo, kept to say who filed a task. */
  private clientName: string | null = null;

  constructor(private deps: BridgeDeps) {
    this.grace = deps.settleGraceMs ?? 30_000;
  }

  async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'initialize':
        this.canElicit = !!params?.clientCapabilities?.elicitation?.form && !!this.deps.request;
        this.clientName = typeof params?.clientInfo?.name === 'string' ? params.clientInfo.name.trim().slice(0, 60) || null : null;
        return this.initialize();
      case 'authenticate': return {};
      case 'session/new': return this.newSession(params ?? {});
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

  private newSession(params: { cwd?: string }) {
    const sessionId = `new-${crypto.randomUUID()}`;
    this.sessions.set(sessionId, { workerId: null, cwd: params.cwd ?? null, cursor: new MessageCursor(), taskMeta: taskMetaFrom(params) });
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
      // Never filtered out: a worker buildd started itself (mission task, review or
      // CI-fix attempt) has no client thread, and the client's project folder says
      // nothing about it. The folder only decides which cwd the entry is filed under.
      let inProject = false;
      if (wanted) {
        inProject = where !== null && (await this.belongsTo(where, wanted));
        if (!inProject) {
          names ??= (await this.deps.projectNamesOf(params.cwd!).catch(() => [])).map(n => n.toLowerCase());
          inProject = !!w.workspaceName && names.includes(w.workspaceName.toLowerCase());
        }
      }
      const cwd = inProject ? params.cwd! : (where ?? params.cwd ?? null);
      if (!cwd) continue;
      const attempt = w.attemptKind ? ATTEMPT_LABEL[w.attemptKind] : null;
      const title = w.taskTitle ?? w.id;
      sessions.push({
        // A worker started from a client thread is listed as that thread, so the
        // client finds it already imported instead of offering a duplicate.
        sessionId: this.deps.links.sessionFor?.(w.id) ?? w.id,
        cwd,
        title: attempt ? `${title} (${attempt})` : title,
        updatedAt: w.lastActivity ? new Date(w.lastActivity).toISOString() : null,
        _meta: { buildd: {
          taskId: w.taskId ?? null,
          status: w.status,
          missionId: w.missionId ?? null,
          workspace: w.workspaceName ?? null,
          worktree: where,
          branch: w.branch ?? null,
        } },
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

  private async loadSession(params: { sessionId?: string; cwd?: string }) {
    const sessionId = params.sessionId;
    if (!sessionId) throw new RpcError(INVALID_PARAMS, 'sessionId required');
    const workerId = this.workerIdFor(sessionId);
    const commands = {
      sessionUpdate: 'available_commands_update',
      availableCommands: BRIDGE_COMMANDS.map(c => ({ name: c.name, description: c.description })),
    };
    if (workerId === null) {
      // A thread the client started that never got its task: still a new thread.
      this.sessions.set(sessionId, { workerId: null, cwd: params.cwd ?? null, cursor: new MessageCursor() });
      this.emit(sessionId, commands);
      return {};
    }
    const worker = await this.findWorker(workerId);
    if (!worker) throw new RpcError(INVALID_PARAMS, `worker ${workerId} is not on this runner`);
    const session: Session = { workerId, cwd: params.cwd ?? null, cursor: new MessageCursor() };
    this.sessions.set(sessionId, session);
    for (const u of session.cursor.next(worker.messages, { live: false })) this.emit(sessionId, u);
    this.emit(sessionId, commands);
    const line = settledText(worker);
    if (line && worker.status === 'waiting') this.emit(sessionId, textUpdate(line));
    return {};
  }

  /** The worker a session id names: a linked thread's worker, else the id itself (an imported worker). */
  private workerIdFor(sessionId: string): string | null {
    const linked = this.deps.links.get(sessionId);
    if (linked) return linked;
    return sessionId.startsWith('new-') ? null : sessionId;
  }

  private async prompt(params: { sessionId?: string; _meta?: unknown; prompt?: Array<{ type: string; text?: string }> }) {
    const sessionId = params.sessionId;
    if (!sessionId) throw new RpcError(INVALID_PARAMS, 'sessionId required');
    const session = this.sessions.get(sessionId) ?? this.adopt(sessionId);
    const text = userTextFrom((params.prompt ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n'));

    if (!session.workerId) {
      session.taskMeta = { ...session.taskMeta, ...taskMetaFrom(params) };
      if (!text || parseCommand(text)) {
        this.emit(sessionId, textUpdate(NEW_THREAD_TEXT));
        return { stopReason: 'end_turn' };
      }
      return this.startTask(session, sessionId, text);
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
    let answered: string | null = null;
    if (command !== 'watch') {
      const route = replyRoute(worker);
      const r = await this.deps.runner.act(workerId, route, text);
      if (r.status >= 400) {
        this.emit(sessionId, textUpdate(refusal(r)));
        return { stopReason: 'end_turn' };
      }
      alreadyMoving = route === 'message';
      if (route === 'answer') answered = waitKey(worker.waitingFor);
    }
    return this.follow(session, sessionId, worker, { watching: command === 'watch', alreadyMoving, answered });
  }

  /**
   * A new thread's first message: a buildd task in the workspace this project
   * is, claimed onto this runner the way `c` in top claims one, then followed
   * like any other run. Everything buildd enforces on a claim (limits, roles,
   * isolation) applies; a claim it refuses leaves the task queued.
   */
  private async startTask(session: Session, sessionId: string, text: string) {
    const end = (line: string) => { this.emit(sessionId, textUpdate(line)); return { stopReason: 'end_turn' as const }; };
    if (!session.cwd) return end('This thread has no project folder, so buildd cannot tell which workspace the task is for.');

    const names = (await this.deps.projectNamesOf(session.cwd).catch(() => [])).map(n => n.toLowerCase());
    let workspaces: BuilddWorkspace[];
    try {
      workspaces = await this.deps.runner.listWorkspaces();
    } catch (err) {
      return end(`Could not read your buildd workspaces: ${(err as Error).message}`);
    }
    const matches = workspaces.filter(ws =>
      names.includes(ws.name?.toLowerCase()) || (!!ws.repo && (names.includes(ws.repo.toLowerCase()) || names.includes(ws.repo.toLowerCase().split('/').pop()!))));
    if (matches.length === 0) {
      return end(`No buildd workspace matches this project (${names.join(', ') || 'no name'}). Connect the repo in buildd first.`);
    }
    let ws = matches[0];
    if (matches.length > 1) {
      const pick = this.canElicit ? await this.chooseWorkspace(sessionId, matches) : null;
      if (!pick) {
        return end(`This folder matches more than one buildd workspace (${matches.map(label).join('; ')}). ${this.canElicit ? 'No workspace was chosen; send the message again to choose one.' : 'Start this task from buildd for now.'}`);
      }
      ws = pick;
    }

    const title = taskTitleFrom(text);
    // Filed reserved for this runner's account, then claimed by id: no other runner
    // can take it in the gap, or the thread would follow nothing (CG-7).
    const created = await this.deps.runner.createTask({ workspaceId: ws.id, title, description: text, ...session.taskMeta, reserve: true,
      // Origin marker the task page reads (context.client): the client names itself.
      context: { client: { kind: 'acp', ...(this.clientName ? { name: this.clientName } : {}) } } });
    const task = (created.body as { task?: { id?: string } } | null)?.task;
    if (created.status >= 400 || !task?.id) return end(`buildd did not create the task. ${refusal(created)}`);

    const claimed = await this.deps.runner.claim(task.id);
    let worker = (claimed.body as { worker?: PublicWorker } | null)?.worker;
    if (claimed.status >= 400 || !worker?.id) {
      // The runner's own dispatch may have claimed the reserved task first: the
      // reservation lets this account's claim through, whichever path makes it.
      // That is this runner running it, so follow that worker.
      worker = await this.ownWorkerFor(task.id);
    }
    if (!worker?.id) {
      return end(`Created the buildd task “${title}” in ${ws.name}. It is held for this runner for 20 minutes, then any runner can take it: this runner could not take it now. ${refusal(claimed)}`);
    }
    session.workerId = worker.id;
    this.deps.links.set(sessionId, worker.id);
    session.cursor.skip(worker.messages);
    this.emit(sessionId, textUpdate(`Started a buildd task in ${ws.name}: “${title}”.`));
    return this.follow(session, sessionId, worker, { watching: true, alreadyMoving: true });
  }

  private async chooseWorkspace(sessionId: string, options: BuilddWorkspace[]): Promise<BuilddWorkspace | null> {
    try {
      const res = await this.deps.request!('elicitation/create', {
        sessionId,
        mode: 'form',
        message: 'This folder matches more than one buildd workspace. Which one is the task for?',
        requestedSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string', title: 'Workspace', oneOf: options.map(ws => ({ const: ws.id, title: label(ws) })) } },
        },
      });
      const id = res?.action === 'accept' ? res.content?.answer : null;
      return options.find(ws => ws.id === id) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Stream the worker until it settles; resolve with the turn's stop reason.
   * A question or permission request that comes up while the turn is open is
   * asked as a form when the client can show one, and the run is followed on
   * once it is answered. Declined, or with no form support, the turn ends on
   * the question and the next typed reply answers it.
   */
  private follow(
    session: Session,
    sessionId: string,
    initial: PublicWorker,
    opts: { watching: boolean; alreadyMoving: boolean; answered?: string | null },
  ): Promise<{ stopReason: StopReason; usage?: ReturnType<typeof usageOf>; _meta?: unknown }> {
    return new Promise((resolve) => {
      let latest = initial;
      let moving = opts.alreadyMoving;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      /** The wait a form is open for, and the last wait this turn answered. */
      let asking: string | null = null;
      let answered: string | null = opts.answered ?? null;

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
        resolve({
          stopReason,
          ...(usage ? { usage } : {}),
          ...(latest.spend ? { _meta: { buildd: { spend: latest.spend } } } : {}),
        });
      };

      const ask = (w: PublicWorker) => {
        const key = waitKey(w.waitingFor)!;
        const form = waitingForm(w.waitingFor!)!;
        asking = key;
        this.deps.request!('elicitation/create', { sessionId, mode: 'form', ...form })
          .then(async (res) => {
            if (asking === key) asking = null;
            if (done) return;
            // Answered elsewhere (dashboard, top) or moved on: this answer is stale.
            if (latest.status !== 'waiting' || waitKey(latest.waitingFor) !== key) return;
            const value = res?.action === 'accept' && typeof res.content?.answer === 'string' ? res.content.answer.trim() : '';
            if (!value) { finish('end_turn'); return; }
            // Mark it answered before posting: the form is closed now, and a re-sent
            // copy of this wait arriving while the post is in flight must not reopen it.
            answered = key;
            const r = await this.deps.runner.act(session.workerId!, 'answer', value);
            if (r.status >= 400) { finish('end_turn', refusal(r)); return; }
          })
          .catch(() => { if (asking === key) asking = null; finish('end_turn'); });
      };

      const onWorker = (w: PublicWorker) => {
        if (done || w.id !== session.workerId) return;
        latest = w;
        const updates = session.cursor.next(w.messages, { live: true });
        for (const u of updates) this.emit(sessionId, u);
        if (w.status === 'working' || updates.length > 0) moving = true;
        if (w.status === 'waiting') {
          const key = waitKey(w.waitingFor);
          // Still showing the wait this turn just answered: the runner has not caught up.
          if (key !== null && key === answered) return;
          if (key !== null && key === asking) return;
          if (this.canElicit && w.waitingFor && waitingForm(w.waitingFor)) { moving = true; ask(w); return; }
        }
        if (moving && isSettled(w.status)) finish('end_turn');
      };

      const onSnapshot = (ids: Set<string>) => {
        const id = session.workerId;
        if (done || !id || ids.has(id)) return;
        // The init frame leaves out settled workers, so a miss is not proof the worker is gone:
        // ask the full list before saying so.
        this.findWorker(id).then(
          (w) => {
            if (done || id !== session.workerId) return;
            if (w) onWorker(w);
            else finish('end_turn', 'This worker is no longer on this runner.');
          },
          () => {},
        );
      };

      const unsubscribe = this.deps.runner.subscribe(onWorker, onSnapshot);
      session.cancelTurn = () => {
        void this.deps.runner.act(session.workerId!, 'pause').catch(() => {});
        finish('cancelled', 'Pausing the run. Reply to resume it.');
      };

      if (opts.watching) {
        if (initial.status === 'waiting' && this.canElicit && initial.waitingFor && waitingForm(initial.waitingFor)) {
          moving = true;
          ask(initial);
        } else if (isSettled(initial.status)) finish('end_turn');
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

  /** A prompt for a session this process never loaded (the client resumed its own thread). */
  private adopt(sessionId: string): Session {
    const session: Session = { workerId: this.workerIdFor(sessionId), cwd: null, cursor: new MessageCursor() };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** A worker on this runner for the task, waiting briefly for a dispatch that is still landing. */
  private async ownWorkerFor(taskId: string): Promise<PublicWorker | undefined> {
    for (let i = 0; i < 6; i++) {
      const found = (await this.deps.runner.listWorkers().catch(() => [] as PublicWorker[])).find(w => w.taskId === taskId);
      if (found) return found;
      await new Promise(r => setTimeout(r, 500));
    }
    return undefined;
  }

  private async findWorker(workerId: string): Promise<PublicWorker | undefined> {
    const workers = await this.deps.runner.listWorkers();
    return workers.find(w => w.id === workerId);
  }

  private emit(sessionId: string, update: SessionUpdate) {
    this.deps.notify(sessionId, update);
  }
}

function label(ws: BuilddWorkspace): string {
  const where = ws.teamName ?? ws.repo;
  return where ? `${ws.name} (${where})` : ws.name;
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
