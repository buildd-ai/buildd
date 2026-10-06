/**
 * Dispatcher Worker. buildd POSTs its task webhook here; each task is routed
 * to its own agent (named by task ID) in the container class buildd picks for
 * it (runner-class.ts), which runs `buildd --once` in a container. See
 * README.md and docs/design/cloudflare-sandbox-runner.md.
 */
import { getAgentByName } from 'agents';
import type { Env } from './env';
import { handleRequest, type AgentHandle } from './http';
import { fetchRunnerSize } from './runner-class';

export { WorkerAgent, WorkerAgentLarge } from './worker-agent';
// Must be a top-level export: WorkerAgent reaches it through ctx.exports.
export { EgressHandler } from './egress';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(
      request,
      env,
      async (taskId, size) => (size === 'large'
        ? (await getAgentByName(env.WorkerAgentLarge, taskId)) as unknown as AgentHandle
        : (await getAgentByName(env.WorkerAgent, taskId)) as unknown as AgentHandle),
      undefined,
      { resolveSize: (taskId, workerId) => fetchRunnerSize({ fetch: (i, init) => fetch(i, init), log: (m) => console.log(m) }, env, taskId, workerId) },
    );
  },
} satisfies ExportedHandler<Env>;
