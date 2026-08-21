import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { workspaceRepoMatches } from '@/lib/repo-scope';

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

  // Find the workspace linked to this repo. Matches on a normalized owner/name,
  // since `workspaces.repo` may hold a bare full name or a clone URL.
  const workspace = await db.query.workspaces.findFirst({
    where: workspaceRepoMatches(repoFullName),
  });

  return NextResponse.json({ workspace: workspace || null });
}
