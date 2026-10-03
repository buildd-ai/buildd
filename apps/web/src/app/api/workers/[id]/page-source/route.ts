/**
 * GET /api/workers/[id]/page-source?sha=&prNumber=&waitSeconds=
 *
 * Where the visual auditor's pages come from for this worker's workspace
 * (docs/design/visual-qa-auditor.md, "Page source"), and which branch to
 * capture (`captureRef`: the mission's integration branch on a mission-branch
 * mission, else trunk). Pages come from the sandbox, or the
 * Vercel preview deployed for the commit, found through the commit's GitHub
 * deployment statuses with the workspace's GitHub App token. Long-polls a
 * still-building preview for at most waitSeconds (<= 45); `decision.error ===
 * 'pending'` means call again. Backs the `get_page_source` MCP action.
 *
 * Read-only. Returns no secret: `auth.*.mapped` only says whether
 * gitConfig.envMapping names the env var.
 *
 * Auth: the API key of the account that owns the worker.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { isUuid } from '@/lib/uuid';
import { githubApi } from '@/lib/github';
import { resolvePageSource } from '@/lib/visual-qa-page-source';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, id),
    columns: { id: true, accountId: true, workspaceId: true, taskId: true },
  });
  if (!worker || worker.accountId !== account.id) return notFound();

  // The capture ref follows the mission's PR base (docs/design/visual-qa-auditor.md,
  // "Page source"), so the worker's mission's integration fields are needed.
  const task = worker.taskId
    ? await db.query.tasks.findFirst({ where: eq(tasks.id, worker.taskId), columns: { missionId: true } })
    : null;
  const mission = task?.missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: { workingBranch: true, integrationBranchEnabled: true },
      })
    : null;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, worker.workspaceId),
    columns: { id: true, gitConfig: true },
    with: {
      githubRepo: {
        columns: { fullName: true, defaultBranch: true },
        with: { installation: { columns: { installationId: true } } },
      },
    },
  });
  if (!workspace) return notFound();

  const url = req.nextUrl.searchParams;
  const prRaw = url.get('prNumber');
  const prNumber = prRaw && /^\d+$/.test(prRaw) ? Number(prRaw) : null;
  if (prRaw && prNumber === null) return NextResponse.json({ error: 'prNumber must be a positive integer' }, { status: 400 });
  const waitRaw = Number(url.get('waitSeconds') ?? 0);

  const installationId = workspace.githubRepo?.installation?.installationId ?? null;
  const result = await resolvePageSource({
    get: installationId ? (path) => githubApi(installationId, path) : null,
    repoFullName: workspace.githubRepo?.fullName ?? null,
    gitConfig: workspace.gitConfig,
    mission: mission ?? null,
    repoDefaultBranch: workspace.githubRepo?.defaultBranch ?? null,
    sha: url.get('sha'),
    prNumber,
    waitSeconds: Number.isFinite(waitRaw) ? waitRaw : 0,
  });
  return NextResponse.json(result);
}
