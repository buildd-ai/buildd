/**
 * POST /api/deployments
 *
 * The human escape hatch for deployment actions: the same operations as
 * POST /api/workers/[id]/deployments, run by buildd with a stored credential
 * named by reference, for a person holding an admin API key (deploy scripts:
 * apps/cloud-runner/scripts/deploy.ts, apps/model-policy/scripts/deploy.ts).
 * Not checked against an Operator grant: the key's holder can already manage
 * the credential. Audited exactly like an Operator action, as principal
 * `admin`. Returns no credential.
 *
 * Body: { workspaceId, provider, project, environment, credentialRef, operation, params? }
 *
 * - `bld_` API keys at admin level only, like the reveal route: no cookie,
 *   no OAuth bearer, no worker or trigger key.
 * - The workspace must belong to the key's team.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { isUuid } from '@/lib/uuid';
import { runDeploymentAction } from '@/lib/deployments/action';
import { deploymentStore } from '@/lib/deployments/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  if (!apiKey || !apiKey.startsWith('bld_')) {
    return NextResponse.json({ error: 'An admin API key (bld_…) is required' }, { status: 401, headers: NO_STORE });
  }
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (!hasTokenRouteAdminAccess(account, req)) {
    return NextResponse.json({ error: 'Requires an admin-level API key' }, { status: 403, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400, headers: NO_STORE });
  }
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  if (!isUuid(workspaceId)) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400, headers: NO_STORE });
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, teamId: true },
  });
  if (!workspace || workspace.teamId !== account.teamId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404, headers: NO_STORE });
  }

  const res = await runDeploymentAction(
    { kind: 'admin', teamId: account.teamId, accountId: account.id, workspaceId: workspace.id },
    body,
    deploymentStore,
  );
  return NextResponse.json(res.body, { status: res.status, headers: NO_STORE });
}
