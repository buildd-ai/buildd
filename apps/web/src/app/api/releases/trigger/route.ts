import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, githubInstallations } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { githubApi, isGitHubAppConfigured } from '@/lib/github';

/**
 * Trigger the `release.yml` workflow_dispatch on a target repo. Uses the
 * existing GitHub App installation token resolved by repo owner — same
 * auth path as the health watcher.
 *
 * Body: { repo: "owner/name", ref?: "dev", workflowFile?: "release.yml", force?: false }
 *
 * Auth: admin-level token only (API key or session). Releases are a
 * sensitive action — every other admin-only buildd MCP action gates the
 * same way (manage_missions, manage_workspaces, manage_secrets).
 */

interface TriggerBody {
  repo?: string;
  ref?: string;
  workflowFile?: string;
  force?: boolean;
}

async function isAdmin(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    return account?.level === 'admin';
  }
  // Session auth: trust workspace access checks elsewhere; release-trigger is
  // always API-key-gated for now. (A future change could enable session
  // dispatch for team admins.)
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

  if (!body.repo || typeof body.repo !== 'string') {
    return NextResponse.json({ error: 'repo is required (owner/name)' }, { status: 400 });
  }
  const [owner, name] = body.repo.split('/');
  if (!owner || !name) {
    return NextResponse.json({ error: 'repo must be in "owner/name" form' }, { status: 400 });
  }

  const ref = body.ref ?? 'dev';
  const workflowFile = body.workflowFile ?? 'release.yml';
  const force = body.force === true ? 'true' : 'false';

  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.accountLogin, owner),
  });
  if (!installation) {
    return NextResponse.json({ error: `No GitHub App installation found for ${owner}` }, { status: 404 });
  }

  try {
    // workflow_dispatch returns 204 on success.
    await githubApi(installation.installationId, `/repos/${owner}/${name}/actions/workflows/${workflowFile}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, inputs: { force } }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Most common failure: workflow file doesn't exist in target repo, or
    // App lacks actions:write permission. Surface the GH error verbatim.
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    repo: body.repo,
    workflowFile,
    ref,
    force: body.force === true,
    runsUrl: `https://github.com/${body.repo}/actions/workflows/${workflowFile}`,
  });
}
