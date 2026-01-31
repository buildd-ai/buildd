import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { desc } from 'drizzle-orm';
import { auth } from '@/auth';

export async function GET() {
  // Dev mode returns empty
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ workspaces: [] });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allWorkspaces = await db.query.workspaces.findMany({
      orderBy: desc(workspaces.createdAt),
    });

    return NextResponse.json({ workspaces: allWorkspaces });
  } catch (error) {
    console.error('Get workspaces error:', error);
    return NextResponse.json({ error: 'Failed to get workspaces' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Dev mode returns mock
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ id: 'dev-workspace', name: 'Dev Workspace' });
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, repoUrl, defaultBranch } = body;

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({
        name,
        repo: repoUrl || null,
        localPath: defaultBranch || null,
      })
      .returning();

    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Create workspace error:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
