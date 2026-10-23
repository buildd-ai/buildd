/**
 * POST /api/workers/[id]/visual-qa { captureRef?, routes?, viewport?, theme? }
 *
 * Dispatches the Visual QA workflow for this worker on the workspace's repo:
 * from trunk (the harness must match the prod clone), with `capture_ref` set to
 * the worker's branch unless the body names another. For a worker whose shell
 * has no authenticated `gh`: the dispatch runs on the workspace's GitHub App
 * installation instead. Returns the run (found by its title) or the runs URL
 * when it has not surfaced yet. Backs the `dispatch_visual_qa` MCP action.
 *
 * Judge is always off: the run posts no PR comment and no check run.
 *
 * Auth: the API key of the account that owns the worker, or a per-task token
 * for that worker's own task.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { isUuid } from '@/lib/uuid';
import { githubVisualQaActions, VISUAL_QA_WORKFLOW_FILE, visualQaRunName } from '@/lib/quality-scout-visual-adapter';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const notFound = () => NextResponse.json({ error: 'Worker not found' }, { status: 404 });
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** A branch name or sha: no spaces, no `..`, nothing a workflow input could smuggle. */
const REF = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// Query strings are allowed (dev fixtures are addressed by `?state=...`). The workflow hands
// routes to capture.ts through the QA_ROUTES env var, never a shell line, and the charset still
// excludes quotes, spaces, `$`, backticks and `;`. A comma always separates routes.
const ROUTES = /^\/[A-Za-z0-9_\-./,:?=&%+]*$/;
const VIEWPORT = /^(mobile|desktop|\d{3,4}x\d{3,4})$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return notFound();

  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.id, id)),
    columns: { id: true, accountId: true, claimedByUserId: true, workspaceId: true, taskId: true, branch: true },
  });
  if (!worker || !callerOwnsWorker(account, worker)) return notFound();

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const captureRef = typeof body.captureRef === 'string' && body.captureRef ? body.captureRef : worker.branch;
  if (!captureRef || !REF.test(captureRef)) return bad('captureRef must be a branch name or commit sha');
  const inputs: Record<string, string> = { capture_ref: captureRef, judge: 'false' };
  if (body.routes !== undefined) {
    if (typeof body.routes !== 'string' || !ROUTES.test(body.routes)) return bad('routes must be comma-separated paths starting with /');
    inputs.routes = body.routes;
  }
  if (body.viewport !== undefined) {
    if (typeof body.viewport !== 'string' || !VIEWPORT.test(body.viewport)) return bad('viewport must be mobile, desktop or WxH');
    inputs.viewport = body.viewport;
  }
  if (body.theme !== undefined) {
    if (body.theme !== 'light' && body.theme !== 'dark') return bad('theme must be light or dark');
    inputs.theme = body.theme;
  }

  const workspace = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, worker.workspaceId)),
    columns: { id: true },
    with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  const installationId = workspace?.githubRepo?.installation?.installationId ?? null;
  const repoFullName = workspace?.githubRepo?.fullName ?? null;
  if (!installationId || !repoFullName) {
    return NextResponse.json({ error: 'Workspace has no GitHub App installation to dispatch with' }, { status: 409 });
  }

  const actions = githubVisualQaActions(installationId, repoFullName);
  if (!(await actions.workflowExists())) {
    return NextResponse.json({ error: `${repoFullName} has no ${VISUAL_QA_WORKFLOW_FILE} workflow` }, { status: 409 });
  }
  const trunk = await actions.harnessRef();
  const dispatchedAt = Date.now();
  await actions.dispatch(trunk, inputs);

  const runsUrl = `https://github.com/${repoFullName}/actions/workflows/${VISUAL_QA_WORKFLOW_FILE}`;
  const title = visualQaRunName(captureRef);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2_500));
    try {
      const run = (await actions.listDispatchRuns(trunk)).find(
        (r) => Date.parse(r.createdAt) >= dispatchedAt - 15_000 && r.displayTitle === title,
      );
      if (run) {
        return NextResponse.json({
          dispatched: true, harnessRef: trunk, inputs, runId: run.id, status: run.status,
          runUrl: `https://github.com/${repoFullName}/actions/runs/${run.id}`, runsUrl,
        });
      }
    } catch {
      // Transient: keep polling, then fall through to the runs URL.
    }
  }
  return NextResponse.json({ dispatched: true, harnessRef: trunk, inputs, runsUrl, note: `run not visible yet; find it titled "${title}"` });
}
