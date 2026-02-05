import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, githubRepos } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);

  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const repoFullName = req.nextUrl.searchParams.get('repo');
  if (!repoFullName) {
    return NextResponse.json({ error: 'repo parameter required' }, { status: 400 });
  }

  // Find workspace linked to this repo
  const repo = await db.query.githubRepos.findFirst({
    where: eq(githubRepos.fullName, repoFullName),
    with: { workspaces: true },
  });

  if (!repo || repo.workspaces.length === 0) {
    return NextResponse.json({ workspace: null });
  }

  // Return the first workspace linked to this repo
  return NextResponse.json({ workspace: repo.workspaces[0] });
}
