/**
 * Proxy route for workspace memory — forwards to memory service.
 *
 * GET  /api/workspaces/:id/memory  → list/search memories (scoped by workspace repo as project)
 * POST /api/workspaces/:id/memory  → save a memory (mirrored into the recall index)
 *
 * Auth: session user or API key with workspace access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { getMemoryStoreForTeam, getMemoryIndexStore } from '@/lib/memory-helper';
import { saveMemory } from '@buildd/core/memory-write';
import { resolveMemoryProjectKey } from '@buildd/core/memory-scope';
import { retrieveMemory } from '@buildd/core/memory-retrieval';
import { afterResponseMemoryLedger } from '@/lib/memory-ledger';

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

/**
 * The workspace's memory project key, by the rule every memory read uses
 * (memoryProjectKey): null for a sensitive workspace, or one whose key is
 * shared with a sensitive workspace in the team. The store is team-wide, so
 * this key is the only thing keeping the dashboard inside the workspace.
 */
async function getWorkspaceProject(id: string): Promise<string | null> {
  return resolveMemoryProjectKey(id);
}

/** The project key plus the team id the memory ledger needs. */
async function getWorkspaceScope(id: string): Promise<{ project: string | null; teamId: string | null }> {
  const [project, ws] = await Promise.all([
    getWorkspaceProject(id),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, id), columns: { teamId: true } }),
  ]);
  return { project, teamId: ws?.teamId ?? null };
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

  const memClient = await getMemoryStoreForTeam(id);
  if (!memClient) {
    return NextResponse.json({ error: 'Workspace team not found' }, { status: 404 });
  }

  const { project, teamId } = await getWorkspaceScope(id);
  // No key means no memory: never fall back to a team-wide list.
  if (!project) {
    // Flagged so the page can say memory is off here, rather than "no memories".
    return NextResponse.json({ memories: [], total: 0, memoryUnavailable: true });
  }
  const searchParams = req.nextUrl.searchParams;
  const query = searchParams.get('search') || searchParams.get('query') || undefined;
  const type = searchParams.get('type') || undefined;
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);
  // File scope: repeated `?files=` params, and comma-separated values inside
  // each, so both `?files=a&files=b` and `?files=a,b` work. The store does the
  // normalising (sentinel, trailing separators, dedupe, cap) — this only has to
  // decide between "a scope was supplied" and "none was".
  const files = searchParams
    .getAll('files')
    .flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(Boolean);

  const search = {
    query, type, project, limit, offset,
    files: files.length > 0 ? files : undefined,
  };

  try {
    // A search (a query or a file scope) is a memory read an agent receives:
    // the runner's `## Workspace Memory` block is built from it. It goes
    // through the one door, which resolves the workspace's project key again
    // itself (no key, no search) and shares the ledger. The ledger row needs the task it was for,
    // which the runner sends as `taskId` / `workerId`; without one (a
    // dashboard search) nothing is recorded.
    if (query || search.files) {
      const taskId = searchParams.get('taskId');
      const { memories, total } = await retrieveMemory({
        strategy: 'store-search',
        searcher: memClient,
        search,
        scope: { teamId, workspaceId: id },
        caller: 'runner_workspace_memory',
        attribution: { taskId, workerId: searchParams.get('workerId') },
        ledger: taskId ? afterResponseMemoryLedger : false,
      });
      return NextResponse.json({ memories, total });
    }

    const searchData = await memClient.search(search);

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
    return NextResponse.json({ error: 'Memory operation failed' }, { status: 500 });
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

  const memClient = await getMemoryStoreForTeam(id);
  if (!memClient) {
    return NextResponse.json({ error: 'Workspace team not found' }, { status: 404 });
  }

  const body = await req.json();
  // Filed under this workspace's key only (a project named in the body is
  // ignored); a workspace with no key gets no memory writes.
  const project = await getWorkspaceProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Memory is disabled for this workspace' }, { status: 403 });
  }

  try {
    // Saved and mirrored into the index recall reads; a failed mirror is logged
    // and re-tried by the reconcile pass, it does not fail the save.
    const data = await saveMemory(memClient, {
      type: body.type,
      title: body.title,
      content: body.content,
      project,
      tags: body.tags || body.concepts || [],
      files: body.files || [],
      source: body.source || 'dashboard',
    }, { teamId: memClient.teamId, knowledgeStore: getMemoryIndexStore(), via: 'dashboard:create' });

    // Return in observation-compatible shape for backward compat
    return NextResponse.json({
      memory: data.memory,
      observation: data.memory,
    }, { status: 201 });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to save memory' }, { status: 500 });
  }
}
