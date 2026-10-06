/**
 * GET /api/workers/[id]/prompt-bundles
 *
 * The role and skill payload the claim response carried for this worker —
 * `skillBundles`, `roleConfig` (with a fresh presigned bundle URL) and
 * `roleInstructions` — resolved again, the same way, for a session that is
 * being resumed by a runner that no longer holds it.
 *
 * The runner keeps that payload in memory only and writes it to disk for the
 * duration of one session (apps/runner/src/session-prompt-files.ts), so a
 * runner restart, or a park → reattach onto a fresh container, loses it. The
 * resumed session calls this before it continues so it has the same skills
 * and persona a fresh claim would.
 *
 * Auth: the runner API key of the account that owns the worker, or the
 * per-task token of that worker's task. Anything else is a 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import type { ClaimTasksResponse, WorkerPromptBundlesResponse } from '@buildd/shared';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker } from '@/lib/task-token-auth';
import { isUuid } from '@/lib/uuid';
import { attachRoleConfig, attachSkillBundles } from '../../claim/skill-and-role-injection';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (account.level === 'trigger') return NextResponse.json({ error: 'Trigger tokens cannot read worker prompt bundles' }, { status: 403 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, taskId: true },
    with: {
      task: {
        columns: { id: true, workspaceId: true, roleSlug: true, context: true },
        with: { workspace: { columns: { teamId: true } } },
      },
    },
  });
  if (!worker || worker.accountId !== account.id || !taskScopeAllowsWorker(account, worker)) return notFound();
  const task = (worker as { task?: Record<string, any> | null }).task;
  if (!task) return notFound();

  // One claim-shaped entry, run through the claim route's own resolvers so a
  // resumed session can never see a different skill set than a fresh one.
  const cw = { id: worker.id, taskId: task.id, task: { id: task.id, context: task.context } } as unknown as ClaimTasksResponse['workers'][number];
  const claimed = [{ id: task.id, workspaceId: task.workspaceId, roleSlug: task.roleSlug, context: task.context, workspace: task.workspace }];
  await attachSkillBundles([cw], claimed, account.id);
  await attachRoleConfig([cw], claimed, account.id);

  const out = cw as any;
  const body: WorkerPromptBundlesResponse = {
    ...(out.skillBundles ? { skillBundles: out.skillBundles } : {}),
    ...(out.roleConfig ? { roleConfig: out.roleConfig } : {}),
    ...(out.roleInstructions ? { roleInstructions: out.roleInstructions } : {}),
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
