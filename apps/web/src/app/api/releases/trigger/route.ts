import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { isGitHubAppConfigured } from '@/lib/github';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { resolveReleaseTarget } from '@/lib/release/target';
import { dispatchWorkflowRelease } from '@/lib/release/dispatch';

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

async function isAdmin(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    return account?.level === 'admin';
  }
  const user = await getCurrentUser();
  return Boolean(user);
}

export async function POST(req: NextRequest) {
  if (!isGitHubAppConfigured()) {
    return NextResponse.json({ error: 'GitHub App not configured on this buildd instance' }, { status: 500 });
  }
  if (!(await isAdmin(req))) {
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

  const overrides = {
    ref: body.ref,
    workflowFile: body.workflowFile,
    inputs: body.inputs,
    force: body.force,
  };
  const resolution = resolveReleaseStrategy(target.releaseConfig, overrides);

  // Resolve a concrete workflow_dispatch even when the workspace isn't configured,
  // PROVIDED the caller passed workflowFile + ref explicitly (ad-hoc dispatch).
  // This keeps an escape hatch without reintroducing a buildd-specific default.
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

  // workflow_dispatch
  try {
    const result = await dispatchWorkflowRelease(target.installationId, target.owner, target.name, {
      workflowFile: strategy.workflowFile,
      ref: strategy.ref,
      inputs: strategy.inputs,
    });
    return NextResponse.json({
      ok: true,
      strategy: 'workflow_dispatch',
      repo: target.repoFullName,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
