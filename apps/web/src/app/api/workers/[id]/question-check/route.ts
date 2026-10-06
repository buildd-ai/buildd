/**
 * POST /api/workers/[id]/question-check  { question, priorPushbacks }
 *
 * The question gate (packages/core/question-gate.ts). A runner whose claim
 * carried a `questionGate` marker calls this before parking an
 * AskUserQuestion, and either parks it (`verdict: 'send'`) or hands the
 * agent `reason` as the tool result (`verdict: 'pushback'`).
 *
 * Server-side because the decision spends the TEAM's key, which never reaches
 * a runner. Every failure inside the check is a 200 `send`; the runner fails
 * open on anything else too (non-200, timeout), so a broken gate never holds
 * a question back.
 *
 * Auth: the API key of the account that owns the worker.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { parseQuestionGateRequest } from '@buildd/core/question-gate';
import { authenticateApiKey } from '@/lib/api-auth';
import { isUuid } from '@/lib/uuid';
import { checkQuestion, gateEnabledFromGitConfig, hardRailContextFromGitConfig } from '@/lib/question-gate-check';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 }); }
  const parsed = parseQuestionGateRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true, taskId: true },
  });
  if (!worker || worker.accountId !== account.id) return notFound();
  if (!worker.taskId) return NextResponse.json({ verdict: 'send', outcome: 'off', version: null, latencyMs: 0 });

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, teamId: true, dataClass: true, gitConfig: true },
  });
  if (!workspace?.teamId) return notFound();

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, worker.taskId),
    columns: { title: true, pathManifest: true, missionId: true },
  });

  const reply = await checkQuestion(
    {
      teamId: workspace.teamId,
      workspaceId: workspace.id,
      accountId: worker.accountId,
      taskId: worker.taskId,
      missionId: task?.missionId ?? null,
      workerId: worker.id,
      taskTitle: task?.title ?? null,
      sensitive: workspace.dataClass === 'sensitive',
      gateEnabled: gateEnabledFromGitConfig(workspace.gitConfig),
      hardRail: {
        ...hardRailContextFromGitConfig(workspace.gitConfig),
        pathManifest: task?.pathManifest ?? null,
      },
    },
    parsed.value,
  );
  return NextResponse.json(reply);
}
