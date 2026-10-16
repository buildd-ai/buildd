/**
 * POST /api/runner/verification-run
 *
 * Whether the cloud runner's dispatcher (apps/cloud-runner) should run a
 * finished cloud run's check command itself, and which command. Asked after
 * the runner process in the container has exited, before the container stops.
 *
 * In a cloud container the runner and the agent share one task token and one
 * process environment, so evidence written on that token is the agent's word
 * (lib/verification-provenance.ts). The dispatcher holds a runner key the
 * container never sees: it execs the command in the container, reads the exit
 * code from the platform, and PATCHes it on that key. The worker is terminal
 * by then, so the report takes the late runner evidence path
 * (lib/late-runner-evidence.ts), which records the verdict.
 *
 * Same two credentials as /api/runner/runner-size, both required:
 *   Authorization: Bearer <runner API key>   an account that may claim the task
 *   X-Buildd-Dispatch-Token: <token>         the workspace's webhookConfig.token
 * A task token is refused: it is what the container holds.
 *
 * Body: { taskId, workerId }. The worker must be this task's, claimed by this
 * account from a cloud container.
 *
 * Response: { taskId, workerId, workspaceId, run: true, command, iteration }
 * for a spec criterion check or a mission `command` criterion, else
 * { taskId, workerId, run: false, reason }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { and, eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveDispatchTask } from '@/lib/agent-capabilities/dispatch-principal';
import { recordCapabilityDecision } from '@/lib/agent-capabilities/audit';
import { verificationRunPlan } from '@/lib/runner-verification-plan';

/** Mirrors DISPATCH_TOKEN_HEADER in apps/cloud-runner/src/outbound.ts. */
const DISPATCH_TOKEN_HEADER = 'x-buildd-dispatch-token';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return fail(401, 'Unauthorized');
  if (account.level === 'trigger') return fail(403, 'Trigger tokens cannot ask for a verification run');
  if ((account as { taskScope?: unknown }).taskScope) return fail(403, 'A task token cannot ask for a verification run');

  const dispatchToken = req.headers.get(DISPATCH_TOKEN_HEADER);
  if (!dispatchToken) return fail(401, 'Dispatch token required');

  let body: { taskId?: unknown; workerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const { taskId, workerId } = body ?? {};
  if (typeof taskId !== 'string' || !ID_RE.test(taskId)) return fail(400, 'taskId is required');
  if (typeof workerId !== 'string' || !ID_RE.test(workerId)) return fail(400, 'workerId is required');

  const resolved = await resolveDispatchTask(account, { taskId, dispatchToken });
  if (!resolved.ok) {
    void recordCapabilityDecision({ capability: 'runner.verification_run', decision: 'refused', accountId: account.id, principalVia: 'dispatch', resource: `task:${taskId}`, reasonCode: resolved.reasonCode });
    return fail(resolved.status, resolved.error);
  }

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(and(eq(workers.id, workerId), eq(workers.taskId, taskId))),
    columns: { id: true, accountId: true, claimedByCloud: true },
  });
  if (!worker || worker.accountId !== account.id || worker.claimedByCloud !== true) {
    void recordCapabilityDecision({ capability: 'runner.verification_run', decision: 'refused', accountId: account.id, principalVia: 'dispatch', workspaceId: resolved.workspace.id, taskId, resource: `worker:${workerId}`, reasonCode: 'not_own_cloud_worker' });
    return fail(404, 'Worker not found');
  }

  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { context: true, loopConfig: true, loopIteration: true },
  });
  if (!task) return fail(404, 'Task not found');

  const plan = verificationRunPlan(task);
  return NextResponse.json(
    plan.run
      ? { taskId, workerId, workspaceId: resolved.workspace.id, run: true, command: plan.command, iteration: plan.iteration }
      : { taskId, workerId, run: false, reason: plan.reason },
    { headers: NO_STORE },
  );
}
