import { NextRequest, NextResponse } from 'next/server';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { isGitHubAppConfigured } from '@/lib/github';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { resolveReleaseTarget } from '@/lib/release/target';
import { dispatchWorkflowRelease, releasePreflight } from '@/lib/release/dispatch';
import { detectArchetype } from '@buildd/core/release-archetype';
import { attributeRelease } from '@buildd/core/release-attribution';
import { db } from '@buildd/core/db';
import { releases } from '@buildd/core/db/schema';

/**
 * Trigger a release on a workspace's repo. The workspace declares HOW it
 * releases via `releaseConfig.strategy` — buildd no longer hardcodes dev→main /
 * release.yml. This route resolves that strategy and dispatches accordingly:
 *
 *   - workflow_dispatch: dispatch the repo's own release workflow + read the run back.
 *   - branch_merge:      runs automatically on task completion (executeRelease),
 *                        not via this standalone trigger — it needs a worker branch.
 *   - script:            not yet implemented.
 *
 * Identify the target by `workspaceId` or `repo` ("owner/name"). For an
 * unconfigured workspace, pass `workflowFile` + `ref` explicitly (an ad-hoc
 * dispatch) — there is no buildd-specific default.
 *
 * Auth: admin-level token only — same gate as manage_missions / manage_secrets.
 */

interface TriggerBody {
  workspaceId?: string;
  repo?: string;
  ref?: string;
  workflowFile?: string;
  inputs?: Record<string, string>;
  force?: boolean;
}

async function resolveAuth(req: NextRequest): Promise<{ authorized: boolean; triggeredBy: 'user' | 'agent' }> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    return { authorized: account?.level === 'admin', triggeredBy: 'agent' };
  }
  const user = await getCurrentUser();
  return { authorized: Boolean(user), triggeredBy: 'user' };
}

export async function POST(req: NextRequest) {
  try {
    if (!isGitHubAppConfigured()) {
      return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
    }
    const { authorized, triggeredBy } = await resolveAuth(req);
    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: TriggerBody;
    try {
      body = (await req.json()) as TriggerBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.workspaceId && !body.repo) {
      return NextResponse.json({ error: 'workspaceId or repo is required' }, { status: 400 });
    }

    const targetResult = await resolveReleaseTarget({ workspaceId: body.workspaceId, repo: body.repo });
    if (!targetResult.ok) {
      return NextResponse.json({ error: targetResult.error }, { status: targetResult.status });
    }
    const target = targetResult.target;

    // Archetype check — none workspaces never trigger a release row or dispatch.
    const archetype = detectArchetype({
      name: target.workspaceName,
      releaseConfig: target.releaseConfig,
      gitConfig: target.gitConfig,
    });
    if (archetype === 'none') {
      return NextResponse.json({ ok: true, status: 'skipped', reason: 'none archetype' });
    }

    const overrides = {
      ref: body.ref,
      workflowFile: body.workflowFile,
      inputs: body.inputs,
      force: body.force,
    };
    const resolution = resolveReleaseStrategy(target.releaseConfig, overrides);

    // Resolve a concrete workflow_dispatch even when the workspace isn't configured,
    // PROVIDED the caller passed workflowFile + ref explicitly (an ad-hoc dispatch).
    let strategy = resolution.ok ? resolution.strategy : null;
    if (!resolution.ok && resolution.reason === 'not_configured' && body.workflowFile && body.ref) {
      const inputs: Record<string, string> = { ...(body.inputs ?? {}) };
      if (body.force !== undefined) inputs.force = body.force ? 'true' : 'false';
      strategy = { kind: 'workflow_dispatch', workflowFile: body.workflowFile, ref: body.ref, inputs };
    }

    if (!strategy) {
      const message = resolution.ok
        ? 'Unresolved release strategy'
        : resolution.reason === 'not_configured'
          ? 'Workspace is not configured for releases. Set releaseConfig, or pass workflowFile + ref explicitly.'
          : resolution.message;
      const status = !resolution.ok && resolution.reason === 'disabled' ? 409 : 422;
      return NextResponse.json({ ok: false, error: message }, { status });
    }

    if (strategy.kind === 'branch_merge') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This workspace uses the branch_merge strategy, which releases automatically on task completion — not via the standalone trigger.',
        },
        { status: 422 },
      );
    }

    if (strategy.kind === 'script') {
      return NextResponse.json(
        { ok: false, error: 'The script release strategy is not yet implemented.' },
        { status: 501 },
      );
    }

    // workflow_dispatch path
    const sourceRef = strategy.ref;
    const prodBranch = target.releaseConfig?.prodBranch ?? target.defaultBranch;

    // Gather T1 readiness data at dispatch time.
    let headSha: string | undefined;
    let previousSha: string | undefined;
    let ciStateAtDispatch: 'passing' | 'failing' | 'pending' | undefined;
    let commitsAheadAtDispatch: number | undefined;

    try {
      const preflight = await releasePreflight(target.installationId, target.owner, target.name, {
        ref: sourceRef,
        prodBranch,
      });
      headSha = preflight.refHeadSha;
      previousSha = preflight.previousSha;
      if (preflight.ciState && preflight.ciState !== 'unknown') {
        ciStateAtDispatch = preflight.ciState as 'passing' | 'failing' | 'pending';
      }
      commitsAheadAtDispatch = preflight.aheadBy;
    } catch {
      // Preflight failure is non-fatal — proceed without T1 data.
    }

    // Idempotency: if a row for this headSha already exists in an in-flight state, return it.
    if (headSha) {
      const existing = await db.query.releases.findFirst({
        where: and(
          eq(releases.workspaceId, target.workspaceId),
          eq(releases.headSha, headSha),
          inArray(releases.state, ['dispatched', 'deploying']),
        ),
      });
      if (existing) {
        return NextResponse.json({
          ok: true,
          strategy: 'workflow_dispatch',
          repo: target.repoFullName,
          releaseId: existing.id,
          deduped: true,
        });
      }
    }

    // Insert the releases row before dispatch so we have a record even if dispatch fails.
    const [releaseRow] = await db
      .insert(releases)
      .values({
        workspaceId: target.workspaceId,
        archetype,
        strategy: 'workflow_dispatch',
        sourceRef,
        targetRef: prodBranch,
        headSha,
        previousSha,
        state: 'dispatched',
        verificationStrategy: archetype === 'gated' ? 'http' : 'none',
        triggeredBy,
        dispatchedAt: new Date(),
        ciStateAtDispatch,
        commitsAheadAtDispatch,
      })
      .returning({ id: releases.id });

    const releaseId = releaseRow.id;

    try {
      const result = await dispatchWorkflowRelease(target.installationId, target.owner, target.name, {
        workflowFile: strategy.workflowFile,
        ref: strategy.ref,
        inputs: strategy.inputs,
      });

      // Back-fill the run URL once we have it from the readback.
      if (result.runUrl) {
        await db.update(releases).set({ runUrl: result.runUrl }).where(eq(releases.id, releaseId));
      }

      // M1 attribution — fire-and-forget; does not block the response.
      if (previousSha && headSha) {
        void attributeRelease({
          releaseId,
          workspaceId: target.workspaceId,
          previousSha,
          headSha,
          archetype,
          repoFullName: target.repoFullName,
          githubInstallationId: target.installationId,
          db: db as any,
        });
      }

      return NextResponse.json({
        ok: true,
        strategy: 'workflow_dispatch',
        repo: target.repoFullName,
        releaseId,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Internal error: ${message}` }, { status: 500 });
  }
}
