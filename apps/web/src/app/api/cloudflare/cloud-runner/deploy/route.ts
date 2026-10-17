/**
 * Settings → Runners → Cloudflare → Deploy: deploy the cloud runner into the
 * team's own Cloudflare account with its stored token, and point one
 * workspace at it. One step per request (lib/deployments/cloud-runner-deploy.ts):
 *
 *   POST { workspaceId, step: check | bucket | worker | containers | connect }
 *   -> { ok, step, next, detail } | { error, step }
 *
 *   GET ?teamId= -> { workspaces: [{ id, name }] }, the workspaces the picker offers.
 *
 * - A signed-in person only: no API key of any level. A key holder has
 *   POST /api/deployments and scripts/deploy.ts.
 * - Same team scoping as /api/deployments: the workspace must be in a team
 *   the person belongs to (else 404, so another team's workspace ids are not
 *   confirmed). Their role there must hold all three of
 *   manage_team_model_keys (use the Cloudflare token), manage_workspace_settings
 *   (set the webhook) and manage_team_keys (mint the runner key): owner/admin.
 * - Every Cloudflare call is a deployment action as principal `user`, audited
 *   before the credential is read; the webhook and runner-key steps are
 *   audited too. No token, runner key or DISPATCH_TOKEN is in any reply.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserTeamRole } from '@/lib/team-access';
import { roleHas, type Permission } from '@/lib/permissions';
import { isUuid } from '@/lib/uuid';
import { appBaseUrl } from '@/lib/app-url';
import { findCloudflareSecret } from '@/lib/cloudflare-credential';
import { runDeploymentAction } from '@/lib/deployments/action';
import { credentialRefOf, deploymentStore } from '@/lib/deployments/store';
import { releaseBundleLoader } from '@/lib/deployments/cloud-runner-release';
import { cloudRunnerDeployStore } from '@/lib/deployments/cloud-runner-store';
import {
  CLOUD_RUNNER_SCRIPT, isCloudRunnerDeployStep, runCloudRunnerDeployStep, type StoredWebhook,
} from '@/lib/deployments/cloud-runner-deploy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const REQUIRED: Permission[] = ['manage_team_model_keys', 'manage_workspace_settings', 'manage_team_keys'];

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A session, never a key: the button is for a person in the dashboard. */
async function sessionUser(req: NextRequest) {
  if (req.headers.get('authorization')) return null;
  return getCurrentUser();
}

export async function GET(req: NextRequest) {
  const user = await sessionUser(req);
  if (!user) return json({ error: 'Sign in to deploy the cloud runner' }, 401);
  const teamId = req.nextUrl.searchParams.get('teamId') ?? '';
  if (!isUuid(teamId) || !(await getUserTeamIds(user.id)).includes(teamId)) return json({ error: 'Team not found' }, 404);
  const role = await getUserTeamRole(user.id, teamId);
  if (!REQUIRED.every((p) => roleHas(role, p))) return json({ workspaces: [] });
  const rows = await db.query.workspaces.findMany({
    where: sqlWhere(eq(workspaces.teamId, teamId)),
    columns: { id: true, name: true },
  });
  return json({ workspaces: rows.map((w) => ({ id: w.id, name: w.name })).sort((a, b) => a.name.localeCompare(b.name)) });
}

export async function POST(req: NextRequest) {
  const user = await sessionUser(req);
  if (!user) return json({ error: 'Sign in to deploy the cloud runner' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const step = body?.step;
  if (!isCloudRunnerDeployStep(step)) return json({ error: 'step must be one of: check, bucket, worker, containers, connect' }, 400);
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (!isUuid(workspaceId)) return json({ error: 'Pick a workspace', step }, 400);

  const workspace = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, teamId: true, name: true, webhookConfig: true },
  });
  const teamIds = workspace ? await getUserTeamIds(user.id) : [];
  if (!workspace || !teamIds.includes(workspace.teamId)) return json({ error: 'Workspace not found', step }, 404);
  const role = await getUserTeamRole(user.id, workspace.teamId);
  if (!REQUIRED.every((p) => roleHas(role, p))) {
    return json({ error: 'Only a team owner or admin can deploy the cloud runner.', step }, 403);
  }

  const secret = await findCloudflareSecret(workspace.teamId);
  if (!secret) return json({ error: 'This team has no Cloudflare token. Add one first.', step }, 404);
  const credentialRef = credentialRefOf(secret.label, 'cloudflare');

  const principal = { teamId: workspace.teamId, userId: user.id, workspaceId: workspace.id };
  const loadRelease = releaseBundleLoader();
  const result = await runCloudRunnerDeployStep(
    step,
    {
      teamId: workspace.teamId,
      userId: user.id,
      workspace: { id: workspace.id, name: workspace.name, webhookConfig: (workspace.webhookConfig ?? null) as StoredWebhook | null },
      builddServer: appBaseUrl(),
    },
    {
      ...cloudRunnerDeployStore(principal, { project: CLOUD_RUNNER_SCRIPT, credentialRef }),
      loadRelease,
      action: (operation, params = {}) => runDeploymentAction(
        { kind: 'user', ...principal },
        { provider: 'cloudflare', project: CLOUD_RUNNER_SCRIPT, environment: 'production', credentialRef, operation, params },
        { ...deploymentStore, loadRelease },
      ),
    },
  );

  if (!result.ok) return json({ error: result.error, step: result.step }, result.status);
  return json({ ok: true, step: result.step, next: result.next, detail: result.detail });
}
