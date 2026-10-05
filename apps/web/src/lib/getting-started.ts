/**
 * Home's getting-started checklist: connect a runner, add an agent key, run a
 * first task. Each step's done state comes from real data (a runner heartbeat,
 * a stored agent-backend credential, a task that succeeded), and the list hides
 * once all three are done. A task that was filed but failed does not tick the
 * third step: that is exactly when a new user still needs the list. Pure; the
 * loader is `getting-started-load.ts`.
 */

export type GettingStartedStepId = 'runner' | 'credential' | 'task';

export interface GettingStartedInput {
  /** A runner of this team has sent a recent heartbeat. */
  runnerConnected: boolean;
  /** The team holds a usable credential an agent backend runs on. */
  hasAgentCredential: boolean;
  /** Where the team's (top-level) tasks stand; see {@link firstTaskState}. */
  firstTask: FirstTaskState;
}

/**
 * none: nothing filed yet (or only cancelled). open: one is queued or running.
 * failed: every one filed so far failed. done: at least one succeeded.
 */
export type FirstTaskState = 'none' | 'open' | 'failed' | 'done';

const TERMINAL_NOT_DONE = new Set(['failed', 'cancelled']);

/** The first-task state from top-level task counts keyed by `tasks.status`. */
export function firstTaskState(countsByStatus: Record<string, number>): FirstTaskState {
  const live = Object.entries(countsByStatus).filter(([, n]) => n > 0);
  if (live.some(([status]) => status === 'completed')) return 'done';
  if (live.some(([status]) => !TERMINAL_NOT_DONE.has(status))) return 'open';
  if (live.some(([status]) => status === 'failed')) return 'failed';
  return 'none';
}

export interface GettingStartedStep {
  id: GettingStartedStepId;
  done: boolean;
  /** The first step not done: the one to do next. */
  current: boolean;
  /** Only on the `task` step: what happened to the first task so far. */
  taskState?: FirstTaskState;
}

export interface GettingStartedChecklist {
  steps: GettingStartedStep[];
  doneCount: number;
  complete: boolean;
  visible: boolean;
}

/**
 * `secrets.purpose` values an agent run can use (docs/credentials-architecture.md):
 * the Claude key or connect, the Codex sign-in or OpenAI key, and a team agent
 * model endpoint (OpenRouter or a LiteLLM gateway). `inference_key` is chat only.
 */
export const AGENT_CREDENTIAL_PURPOSES = [
  'anthropic_api_key',
  'oauth_token',
  'claude_credential',
  'codex_credential',
  'openai_api_key',
  'agent_endpoint',
] as const;

const ORDER: GettingStartedStepId[] = ['runner', 'credential', 'task'];

export function gettingStartedChecklist(input: GettingStartedInput): GettingStartedChecklist {
  const done: Record<GettingStartedStepId, boolean> = {
    runner: input.runnerConnected,
    credential: input.hasAgentCredential,
    task: input.firstTask === 'done',
  };
  const currentId = ORDER.find((id) => !done[id]) ?? null;
  const steps: GettingStartedStep[] = ORDER.map((id) => ({
    id,
    done: done[id],
    current: id === currentId,
    ...(id === 'task' ? { taskState: input.firstTask } : {}),
  }));
  const doneCount = steps.filter((s) => s.done).length;
  const complete = doneCount === steps.length;
  return { steps, doneCount, complete, visible: !complete };
}
