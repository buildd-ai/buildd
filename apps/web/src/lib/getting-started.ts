/**
 * Home's getting-started checklist: connect a runner, add an agent key, file a
 * first task. Each step's done state comes from real data (a runner heartbeat,
 * a stored agent-backend credential, a task row), and the list hides once all
 * three are done. Pure; the loader is `getting-started-load.ts`.
 */

export type GettingStartedStepId = 'runner' | 'credential' | 'task';

export interface GettingStartedInput {
  /** A runner of this team has sent a recent heartbeat. */
  runnerConnected: boolean;
  /** The team holds a usable credential an agent backend runs on. */
  hasAgentCredential: boolean;
  /** At least one (top-level) task exists. */
  hasTask: boolean;
}

export interface GettingStartedStep {
  id: GettingStartedStepId;
  done: boolean;
  /** The first step not done: the one to do next. */
  current: boolean;
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
    task: input.hasTask,
  };
  const currentId = ORDER.find((id) => !done[id]) ?? null;
  const steps = ORDER.map((id) => ({ id, done: done[id], current: id === currentId }));
  const doneCount = steps.filter((s) => s.done).length;
  const complete = doneCount === steps.length;
  return { steps, doneCount, complete, visible: !complete };
}
