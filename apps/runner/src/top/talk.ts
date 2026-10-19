/**
 * `s` in `buildd top`: talk to a mission's planner (or steer one task's agent)
 * in an interactive `claude` session on this machine; `S` does the same in `codex`.
 *
 * The session runs on whatever `claude` login the machine already has: buildd
 * never stores or hands out a model login, so this adds no server-side
 * credential path. It is a person's session, not a runner agent; nothing here
 * paces it, and a held runner does not stop it (a hold stops claims).
 *
 * This file builds what to run (pure, unit-tested) and runs it. The key
 * handling lives in keys.ts and the terminal hand-over in run.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { resolveBuilddHome } from '../buildd-home';
import { NO_MISSION, isLooseKey, missionRows, taskRows, type TopState } from './state';

export const NOT_LOGGED_IN = "Claude isn't logged in on this machine: run claude login";

export interface TalkTarget {
  kind: 'mission' | 'task';
  id: string;
  title: string;
}

export interface TalkContext {
  target: TalkTarget;
  missionTitle?: string | null;
  description?: string | null;
  /** `verdict` is the last grading (pass, fail, UNVERIFIED, PENDING…); absent when never graded. */
  goals?: Array<{ label: string; verdict?: string }>;
  /** Open tasks, each with why it is not running (`waiting`) or what it is doing. */
  tasks?: Array<{ id: string; title: string; status: string; waiting?: string | null }>;
  /** Questions an agent has put to the owner. */
  questions?: Array<{ taskId: string; taskTitle: string; prompt: string }>;
  /** The server's one-line situation and next step (the same data `explain` returns). */
  situation?: string | null;
  nextAction?: string | null;
  /** For a task target: what its agent is doing now. */
  taskStatus?: string | null;
  taskWaiting?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function starterPrompt(c: TalkContext): string {
  const L: string[] = [];
  if (c.target.kind === 'mission') {
    L.push(`You are the organizer for the buildd mission "${c.target.title}" (mission id ${c.target.id}).`);
  } else {
    L.push(`You are steering the agent working on the buildd task "${c.target.title}" (task id ${c.target.id})${c.missionTitle ? `, part of the mission "${c.missionTitle}"` : ''}.`);
    if (c.taskStatus) L.push(`Task status: ${c.taskStatus}${c.taskWaiting ? ` (${c.taskWaiting})` : ''}.`);
  }
  if (c.description?.trim()) L.push('', 'Description:', clip(c.description.trim(), 2000));
  if (c.situation) L.push('', `Where it stands: ${c.situation}`);
  if (c.nextAction) L.push(`What would move it: ${c.nextAction}`);
  if (c.goals?.length) {
    L.push('', 'Goal criteria:');
    for (const g of c.goals) L.push(`- [${g.verdict ?? 'not checked'}] ${clip(g.label, 200)}`);
  }
  if (c.tasks?.length) {
    L.push('', 'Open tasks:');
    for (const t of c.tasks.slice(0, 40)) L.push(`- ${clip(t.title, 120)} (${t.id.slice(0, 8)}, ${t.status}${t.waiting ? `: ${t.waiting}` : ''})`);
    if (c.tasks.length > 40) L.push(`- …and ${c.tasks.length - 40} more`);
  }
  if (c.questions?.length) {
    L.push('', 'Waiting on the owner:');
    for (const q of c.questions) L.push(`- ${clip(q.taskTitle, 80)} (${q.taskId.slice(0, 8)}) asks: ${clip(q.prompt, 300)}`);
  }
  L.push('', 'Start by telling me, in a few lines, where this stands and what you would do next. Then wait for me.');
  return L.join('\n');
}

export function systemPromptAddendum(kind: 'mission' | 'task'): string {
  const common = [
    'You are in an interactive session with the owner, outside any runner agent. Change the plan through buildd (the buildd MCP) so buildd keeps tracking it: create_task, update_task, send_agent_message, answer_question.',
    'Never edit code in this checkout: it is shared with runner agents. Work that needs code goes into a task for an agent.',
  ];
  return (kind === 'mission'
    ? ['You are this mission\'s organizer. Plan, re-plan, answer the agents\' questions and keep the goal criteria in view.', ...common]
    : ['You are steering one task\'s agent. Talk to it with send_agent_message, answer its questions with answer_question, and adjust the task with update_task.', ...common]
  ).join('\n');
}

export interface TalkEnv {
  TMUX?: string;
  [k: string]: string | undefined;
}

/** Which CLI the session runs in: `s` opens Claude, `S` opens Codex. */
export type TalkAgent = 'claude' | 'codex';
export const AGENT_NAME: Record<TalkAgent, string> = { claude: 'Claude', codex: 'Codex' };
export const notLoggedIn = (agent: TalkAgent) => (agent === 'claude' ? NOT_LOGGED_IN : "Codex isn't logged in on this machine: run codex login");

/** Codex reads the buildd key for its MCP server from this variable (never argv). */
export const CODEX_TOKEN_ENV = 'BUILDD_TALK_TOKEN';

export type TalkLaunch =
  | { ok: false; message: string }
  | {
      ok: true;
      agent: TalkAgent;
      /** Where the session shows up: top steps aside (`suspend`) or a pane opens beside it. */
      mode: 'suspend' | 'tmux';
      cwd: string;
      /**
       * The session being resumed, or the id a new Claude session is given.
       * Null for a new Codex session: codex picks its own id (findNew reads it after).
       */
      sessionId: string | null;
      resumed: boolean;
      /** The command and its arguments; the key is in a 0600 file, never here. */
      argv: string[];
      /** Claude's `--mcp-config` file. */
      mcpConfig?: { mcpServers: Record<string, unknown> };
      /** Environment the session needs that must not be on a command line (the key, for Codex). */
      secretEnv?: Record<string, string>;
    };

/**
 * What to run, or why not. `mcpConfigPath` is where the caller will write
 * Claude's MCP config (the key lives in that 0600 file, not on the command line).
 */
export function buildTalkLaunch(input: {
  agent?: TalkAgent;
  context: TalkContext;
  loggedIn: boolean;
  cwd: string | null;
  server: string;
  apiKey: string | null;
  /** The target's workspace: binds the buildd MCP to it, since one key can reach several. */
  workspaceId?: string | null;
  /** The target's earlier session, still on disk: resume it instead of starting over. */
  resumeSessionId?: string | null;
  /** The id a new Claude session gets, so a later `s` can come back to it. */
  newSessionId: string;
  mcpConfigPath: string;
  env: TalkEnv;
}): TalkLaunch {
  const agent = input.agent ?? 'claude';
  const name = AGENT_NAME[agent];
  if (!input.loggedIn) return { ok: false, message: notLoggedIn(agent) };
  if (!input.cwd) return { ok: false, message: `This machine has no checkout of ${input.context.target.title}'s repository to open ${name} in.` };
  if (!input.apiKey) return { ok: false, message: `The runner has no buildd key to connect ${name} with.` };
  const query = input.workspaceId ? `?workspace=${encodeURIComponent(input.workspaceId)}` : '';
  const url = `${input.server.replace(/\/+$/, '')}/api/mcp${query}`;
  const resume = input.resumeSessionId || null;
  const system = systemPromptAddendum(input.context.target.kind);
  const mode = input.env.TMUX ? 'tmux' : 'suspend';
  if (agent === 'codex') {
    // -c values are TOML; a JSON string is a valid TOML basic string.
    const config = [
      '-c', `mcp_servers.buildd.url=${JSON.stringify(url)}`,
      '-c', `mcp_servers.buildd.bearer_token_env_var=${JSON.stringify(CODEX_TOKEN_ENV)}`,
      '-c', `developer_instructions=${JSON.stringify(system)}`,
    ];
    return {
      ok: true, agent, mode, cwd: input.cwd,
      sessionId: resume,
      resumed: !!resume,
      argv: resume ? ['codex', 'resume', resume, ...config] : ['codex', ...config, starterPrompt(input.context)],
      secretEnv: { [CODEX_TOKEN_ENV]: input.apiKey },
    };
  }
  const entry = { type: 'http', url, headers: { Authorization: `Bearer ${input.apiKey}` } };
  return {
    ok: true, agent, mode, cwd: input.cwd,
    sessionId: resume ?? input.newSessionId,
    resumed: !!resume,
    argv: [
      'claude',
      '--mcp-config', input.mcpConfigPath,
      '--append-system-prompt', system,
      // A resumed session already has its conversation; it opens where it left off.
      ...(resume ? ['--resume', resume] : ['--session-id', input.newSessionId, starterPrompt(input.context)]),
    ],
    mcpConfig: { mcpServers: { buildd: entry } },
  };
}

/** `claude auth status` / `codex login status` exit 0 only when a login is present. */
export async function claudeLoggedIn(spawn: (cmd: string[]) => Promise<number> = defaultSpawnQuiet): Promise<boolean> {
  try { return (await spawn(['claude', 'auth', 'status'])) === 0; } catch { return false; }
}

export async function codexLoggedIn(spawn: (cmd: string[]) => Promise<number> = defaultSpawnQuiet): Promise<boolean> {
  try { return (await spawn(['codex', 'login', 'status'])) === 0; } catch { return false; }
}

async function defaultSpawnQuiet(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  return p.exited;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run the launch: write the MCP config and any secret env 0600 in a private
 * dir, start the session on the terminal (inherit, after top has left the alt
 * screen) or in a tmux split, wait for it to end, and remove the files.
 * Returns the session's exit code.
 */
export async function runTalk(launch: Extract<TalkLaunch, { ok: true }>, io: { configDir?: string; onPane?: (paneId: string) => void } = {}): Promise<number> {
  const dir = mkdtempSync(join(io.configDir ?? tmpdir(), 'buildd-talk-'));
  try {
    const argv = [...launch.argv];
    if (launch.mcpConfig) {
      const cfg = join(dir, 'mcp.json');
      writeFileSync(cfg, JSON.stringify(launch.mcpConfig), { mode: 0o600 });
      // The builder named a path for the config; point it at the file just written.
      const i = argv.indexOf('--mcp-config');
      if (i >= 0) argv[i + 1] = cfg;
    }
    const secrets = Object.entries(launch.secretEnv ?? {});
    if (launch.mode === 'tmux') {
      // The pane reads each secret from its 0600 file, so it is never in tmux's argv.
      const exports = secrets.map(([k, v]) => {
        const f = join(dir, `env-${k}`);
        writeFileSync(f, v, { mode: 0o600 });
        return `export ${k}="$(cat ${shq(f)})"; `;
      }).join('');
      // The pane signals the channel when the session ends; -P prints the pane's id so a later `s` can focus it.
      const channel = `buildd-talk-${process.pid}-${Date.now()}`;
      const inner = `${exports}${argv.map(shq).join(' ')}; tmux wait-for -S ${channel}`;
      const split = Bun.spawn(['tmux', 'split-window', '-h', '-P', '-F', '#{pane_id}', '-c', launch.cwd, inner], { stdout: 'pipe', stderr: 'ignore' });
      const [code, out] = await Promise.all([split.exited, new Response(split.stdout).text()]);
      if (code !== 0) return code;
      if (out.trim()) io.onPane?.(out.trim());
      return await Bun.spawn(['tmux', 'wait-for', channel], { stdout: 'ignore', stderr: 'ignore' }).exited;
    }
    const env = secrets.length ? { ...process.env, ...launch.secretEnv } : undefined;
    const p = Bun.spawn(argv, { cwd: launch.cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    return await p.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the runner's `/api/talk-context` answers (index.ts). */
export interface TalkPayload {
  cwd: string | null;
  server: string | null;
  apiKey: string | null;
  /** The workspace whose checkout `cwd` is (absent from runners older than this field). */
  workspaceId?: string | null;
  explain?: any;
  mission?: any;
}

/**
 * The workspace the target belongs to, so the runner can find its checkout.
 * Null for work no workspace owns (the "(no mission)" row has no target anyway).
 */
export function talkWorkspaceId(state: TopState, target: TalkTarget, now: number): string | undefined {
  if (target.kind === 'mission') return missionRows(state, now).find(r => r.key === target.id)?.workspaceId;
  const t = state.tasks.find(x => x.id === target.id);
  return t?.workspaceId ?? t?.workspace?.id ?? undefined;
}

/**
 * Everything the starter prompt says, from top's own view (the open tasks and
 * why each waits, the questions waiting on the owner) and the server's
 * `explain` answer and mission row.
 */
export function talkContext(state: TopState, target: TalkTarget, payload: Pick<TalkPayload, 'explain' | 'mission'>, now: number): TalkContext {
  const answer = payload.explain?.answer ?? payload.explain ?? null;
  const mission = payload.mission ?? null;
  const task = target.kind === 'task' ? state.tasks.find(t => t.id === target.id) : undefined;
  const missionKey = target.kind === 'mission' ? target.id : (task?.missionId || NO_MISSION);
  // taskRows lists the selected mission's tasks, which is the target's mission here.
  const rows = taskRows(state, now).filter(r => r.kind !== 'done' && r.kind !== 'cancelled');
  const onMission = isLooseKey(missionKey) ? [] : rows;
  const grading: Array<{ label?: string; verdict?: string }> = mission?.goalCriteriaState?.criteria ?? [];
  const goals = Array.isArray(mission?.goalCriteria)
    ? mission.goalCriteria.map((g: any, i: number) => ({
        label: String(g.label ?? g.description ?? g.command ?? g.type ?? `criterion ${i + 1}`),
        verdict: grading[i]?.verdict,
      }))
    : undefined;
  const row = target.kind === 'task' ? rows.find(r => r.taskId === target.id) : undefined;
  return {
    target,
    missionTitle: target.kind === 'task' ? task?.mission?.title ?? null : null,
    description: mission?.description ?? null,
    situation: answer?.situation?.headline ?? null,
    nextAction: answer?.nextAction ?? null,
    goals,
    tasks: onMission.map(r => ({ id: r.taskId, title: r.title, status: r.kind, waiting: r.reason ?? r.action ?? null })),
    questions: onMission.filter(r => r.kind === 'asking' && r.question).map(r => ({ taskId: r.taskId, taskTitle: r.title, prompt: r.question! })),
    taskStatus: row?.kind ?? task?.status ?? null,
    taskWaiting: row?.question ?? row?.reason ?? row?.action ?? null,
  };
}

// ── Coming back to a session ──────────────────────────────────────────────
// `s` on a target that already had a session resumes it (claude --resume), and
// in tmux a pane still showing it is focused instead of opening a second copy.
// top remembers one session per mission or task in BUILDD_HOME.

export interface TalkSessionRecord {
  /** Null while a new Codex session runs (its id is read once it ends). */
  sessionId: string | null;
  cwd: string;
  /** The tmux pane showing it, while it is open there. */
  paneId?: string | null;
}

export interface TalkSessions {
  get(key: string): TalkSessionRecord | null;
  set(key: string, rec: TalkSessionRecord): void;
  /** The CLI still has the conversation (its transcript is on disk). */
  exists(sessionId: string, agent: TalkAgent): boolean;
  /** The Codex session that started in `cwd` since `sinceMs` (codex names its own sessions). */
  findNew(agent: TalkAgent, cwd: string, sinceMs: number): string | null;
  /** Focus a pane if it is still open; false when it is gone. */
  focusPane(paneId: string): Promise<boolean>;
  newId(): string;
}

/** Claude and Codex sessions on the same target are kept apart. */
export const talkSessionKey = (t: Pick<TalkTarget, 'kind' | 'id'>, agent: TalkAgent = 'claude') =>
  agent === 'claude' ? `${t.kind}:${t.id}` : `${agent}:${t.kind}:${t.id}`;

/** claude keeps each conversation as `<config>/projects/<project>/<session id>.jsonl`. */
export function claudeTranscriptExists(sessionId: string, env: TalkEnv = process.env): boolean {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  try {
    return readdirSync(projects).some(d => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

const codexSessionsDir = (env: TalkEnv) => join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

function codexRollouts(env: TalkEnv): string[] {
  try {
    return (readdirSync(codexSessionsDir(env), { recursive: true }) as string[])
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(codexSessionsDir(env), f));
  } catch {
    return [];
  }
}

/** codex keeps each conversation as `<home>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`. */
export function codexTranscriptExists(sessionId: string, env: TalkEnv = process.env): boolean {
  return codexRollouts(env).some(f => f.endsWith(`-${sessionId}.jsonl`));
}

/**
 * The newest Codex session that started in `cwd` since `sinceMs`: its rollout's
 * first line is `session_meta` with the id and the folder it ran in.
 */
export function findCodexSession(cwd: string, sinceMs: number, env: TalkEnv = process.env): string | null {
  let best: { id: string; at: number } | null = null;
  for (const f of codexRollouts(env)) {
    try {
      const at = statSync(f).mtimeMs;
      if (at < sinceMs || (best && at <= best.at)) continue;
      const first = readFileSync(f, 'utf8').split('\n', 1)[0];
      const meta = JSON.parse(first);
      if (meta?.type === 'session_meta' && meta.payload?.cwd === cwd && typeof meta.payload.id === 'string') best = { id: meta.payload.id, at };
    } catch { /* not a rollout we can read */ }
  }
  return best?.id ?? null;
}

export function fileTalkSessions(path = join(resolveBuilddHome(), 'talk-sessions.json')): TalkSessions {
  const read = (): Record<string, TalkSessionRecord> => {
    try { return JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { return {}; }
  };
  return {
    get: key => read()[key] ?? null,
    set(key, rec) {
      const all = read();
      all[key] = rec;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, path);
    },
    exists: (id, agent) => (agent === 'codex' ? codexTranscriptExists(id) : claudeTranscriptExists(id)),
    findNew: (agent, cwd, since) => (agent === 'codex' ? findCodexSession(cwd, since) : null),
    async focusPane(paneId) {
      const p = Bun.spawn(['tmux', 'select-pane', '-t', paneId], { stdout: 'ignore', stderr: 'ignore' });
      return (await p.exited) === 0;
    },
    newId: () => crypto.randomUUID(),
  };
}
