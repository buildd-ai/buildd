/**
 * Proxy route for workspace memory — forwards to memory service.
 *
 * GET  /api/workspaces/:id/memory  → list/search memories (scoped by workspace repo as project)
 * POST /api/workspaces/:id/memory  → save a memory
 *
 * Auth: session user or API key with workspace access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, accounts, teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { MemoryClient } from '@buildd/core/memory-client';

async function getMemoryClientForWorkspace(workspaceId: string): Promise<MemoryClient | null> {
  const url = process.env.MEMORY_API_URL;
  if (!url) return null;

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws) return null;

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, ws.teamId),
    columns: { id: true, memoryApiKey: true },
  });

  if (team?.memoryApiKey) {
    return new MemoryClient(url, team.memoryApiKey);
  }

  // Auto-provision: create a memory team + key for this Buildd team
  const rootKey = process.env.MEMORY_ROOT_KEY;
  if (team && rootKey) {
    try {
      const res = await fetch(`${url}/api/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rootKey}`,
        },
        body: JSON.stringify({ teamId: team.id, name: 'buildd-auto' }),
      });
      if (res.ok) {
        const data = await res.json();
        const newKey = data.key as string;
        await db.update(teams).set({ memoryApiKey: newKey }).where(eq(teams.id, team.id));
        return new MemoryClient(url, newKey);
      }
    } catch (err) {
      console.error('Failed to auto-provision memory key:', err);
    }
  }

  return null;
}

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) return { type: 'api' as const, account };
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

async function verifyAccess(auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>, workspaceId: string): Promise<boolean> {
  if (auth.type === 'session') {
    return !!(await verifyWorkspaceAccess(auth.user.id, workspaceId));
  } else if (auth.type === 'api') {
    return !!(await verifyAccountWorkspaceAccess(auth.account.id, workspaceId));
  }
  return true; // dev mode
}

async function getWorkspaceProject(id: string): Promise<string | undefined> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { repo: true, name: true },
  });
  return ws?.repo || ws?.name || undefined;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await verifyAccess(auth, id))) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const memClient = await getMemoryClientForWorkspace(id);
  if (!memClient) {
    return NextResponse.json({ error: 'Memory service not configured' }, { status: 503 });
  }

  const project = await getWorkspaceProject(id);
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get('search') || searchParams.get('query') || undefined;
  const type = searchParams.get('type') || undefined;
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  try {
    const searchData = await memClient.search({ query, type, project, limit, offset });

    if (searchData.results.length === 0) {
      return NextResponse.json({ memories: [], total: 0 });
    }

    // Fetch full content
    const batchData = await memClient.batch(searchData.results.map(r => r.id));
    return NextResponse.json({
      memories: batchData.memories || [],
      total: searchData.total,
    });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Memory service unavailable' }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await verifyAccess(auth, id))) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const memClient = await getMemoryClientForWorkspace(id);
  if (!memClient) {
    return NextResponse.json({ error: 'Memory service not configured' }, { status: 503 });
  }

  const body = await req.json();
  const project = await getWorkspaceProject(id);

  try {
    const data = await memClient.save({
      type: body.type,
      title: body.title,
      content: body.content,
      project: project || undefined,
      tags: body.tags || body.concepts || [],
      files: body.files || [],
      source: body.source || 'dashboard',
    });

    // Return in observation-compatible shape for backward compat
    return NextResponse.json({
      memory: data.memory,
      observation: data.memory,
    }, { status: 201 });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to save memory' }, { status: 502 });
  }
}
