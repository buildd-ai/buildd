/**
 * Dispatcher Worker. buildd POSTs its task webhook here; each task is routed
 * to its own WorkerAgent (named by task ID), which runs `buildd --once` in a
 * container. See README.md and docs/design/cloudflare-sandbox-runner.md.
 */
import { getAgentByName } from 'agents';
import type { Env } from './env';
import { handleRequest, type AgentHandle } from './http';

export { WorkerAgent } from './worker-agent';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, async (taskId) =>
      (await getAgentByName(env.WorkerAgent, taskId)) as unknown as AgentHandle);
  },
} satisfies ExportedHandler<Env>;
