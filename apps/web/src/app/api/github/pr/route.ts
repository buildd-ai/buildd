import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { authenticateApiKey } from '@/lib/api-auth';

// POST /api/github/pr - Create a pull request
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { workerId, title, body: prBody, head, base, draft } = body;

    if (!workerId) {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 });
    }

    if (!title || !head) {
      return NextResponse.json({ error: 'title and head branch required' }, { status: 400 });
    }

    // Get the worker and its workspace
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      with: { workspace: true },
    });

    if (!worker) {
      return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    }

    // Verify the account owns this worker
    if (worker.accountId !== account.id) {
      return NextResponse.json({ error: 'Worker belongs to different account' }, { status: 403 });
    }

    const workspace = worker.workspace;
    if (!workspace?.githubRepoId || !workspace?.githubInstallationId) {
      return NextResponse.json({ error: 'Workspace not linked to GitHub repo' }, { status: 400 });
    }

    // Get the GitHub repo details
    const repo = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, workspace.githubRepoId),
      with: { installation: true },
    });

    if (!repo || !repo.installation) {
      return NextResponse.json({ error: 'GitHub repo not found' }, { status: 404 });
    }

    // Create the PR via GitHub API
    const prData = await githubApi(
      repo.installation.installationId,
      `/repos/${repo.fullName}/pulls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: prBody || `Created by buildd worker ${worker.name}`,
          head,
          base: base || repo.defaultBranch || 'main',
          draft: draft || false,
        }),
      }
    );

    // Update worker with PR info
    await db
      .update(workers)
      .set({
        prUrl: prData.html_url,
        prNumber: prData.number,
        updatedAt: new Date(),
      })
      .where(eq(workers.id, workerId));

    return NextResponse.json({
      ok: true,
      pr: {
        number: prData.number,
        url: prData.html_url,
        state: prData.state,
        title: prData.title,
      },
    });
  } catch (error) {
    console.error('Create PR error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
