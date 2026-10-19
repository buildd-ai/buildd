/**
 * `s` in `buildd top`: talk to a mission's planner (or steer one task's agent)
 * in an interactive `claude` session on this machine.
 *
 * The session runs on whatever `claude` login the machine already has: buildd
 * never stores or hands out a model login, so this adds no server-side
 * credential path. It is a person's session, not a runner agent; nothing here
 * paces it, and a held runner does not stop it (a hold stops claims).
 *
 * This file builds what to run (pure, unit-tested) and runs it. The key
 * handling lives in keys.ts and the terminal hand-over in run.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

export type TalkLaunch =
  | { ok: false; message: string }
  | {
      ok: true;
      /** Where the session shows up: top steps aside (`suspend`) or a pane opens beside it. */
      mode: 'suspend' | 'tmux';
      cwd: string;
      /** `claude` and its arguments; the MCP config is a file path, never the key itself. */
      argv: string[];
      mcpConfig: { mcpServers: Record<string, unknown> };
    };

/**
 * What to run, or why not. `mcpConfigPath` is where the caller will write the
 * MCP config (the key lives in that 0600 file, not on the command line).
 */
export function buildTalkLaunch(input: {
  context: TalkContext;
  loggedIn: boolean;
  cwd: string | null;
  server: string;
  apiKey: string | null;
  mcpConfigPath: string;
  env: TalkEnv;
}): TalkLaunch {
  if (!input.loggedIn) return { ok: false, message: NOT_LOGGED_IN };
  if (!input.cwd) return { ok: false, message: `This machine has no checkout of ${input.context.target.title}'s repository to open Claude in.` };
  if (!input.apiKey) return { ok: false, message: 'The runner has no buildd key to connect Claude with.' };
  const entry = { type: 'http', url: `${input.server.replace(/\/+$/, '')}/api/mcp`, headers: { Authorization: `Bearer ${input.apiKey}` } };
  return {
    ok: true,
    mode: input.env.TMUX ? 'tmux' : 'suspend',
    cwd: input.cwd,
    argv: [
      'claude',
      '--mcp-config', input.mcpConfigPath,
      '--append-system-prompt', systemPromptAddendum(input.context.target.kind),
      starterPrompt(input.context),
    ],
    mcpConfig: { mcpServers: { buildd: entry } },
  };
}

/** `claude auth status` exits 0 only when a login is present. */
export async function claudeLoggedIn(spawn: (cmd: string[]) => Promise<number> = defaultSpawnQuiet): Promise<boolean> {
  try { return (await spawn(['claude', 'auth', 'status'])) === 0; } catch { return false; }
}

async function defaultSpawnQuiet(cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  return p.exited;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run the launch: write the MCP config 0600 in a private dir, start claude on
 * the terminal (inherit, after top has left the alt screen) or in a tmux split,
 * wait for it to end, and remove the config. Returns claude's exit code.
 */
export async function runTalk(launch: Extract<TalkLaunch, { ok: true }>, io: { configDir?: string } = {}): Promise<number> {
  const dir = mkdtempSync(join(io.configDir ?? tmpdir(), 'buildd-talk-'));
  const cfg = join(dir, 'mcp.json');
  try {
    writeFileSync(cfg, JSON.stringify(launch.mcpConfig), { mode: 0o600 });
    // The builder named a path for the config; point it at the file just written.
    const argv = [...launch.argv];
    const i = argv.indexOf('--mcp-config');
    if (i >= 0) argv[i + 1] = cfg;
    if (launch.mode === 'tmux') {
      // -P blocks until the pane's command ends (tmux wait-for would need a channel); -d keeps top focused.
      const channel = `buildd-talk-${process.pid}`;
      const inner = `${argv.map(shq).join(' ')}; tmux wait-for -S ${channel}`;
      const split = Bun.spawn(['tmux', 'split-window', '-h', '-c', launch.cwd, inner], { stdout: 'ignore', stderr: 'ignore' });
      const code = await split.exited;
      if (code !== 0) return code;
      return await Bun.spawn(['tmux', 'wait-for', channel], { stdout: 'ignore', stderr: 'ignore' }).exited;
    }
    const p = Bun.spawn(argv, { cwd: launch.cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
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
