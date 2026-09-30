/**
 * Individual memory operations — proxies to memory service.
 *
 * PATCH  /api/workspaces/:id/memory/:memoryId  → update a memory, or, with
 *        `{ action: 'promote' | 'dismiss' | 'reverified' }`, apply a review
 *        action (team admins only; see MEMORY_REVIEW_ACTIONS)
 * DELETE /api/workspaces/:id/memory/:memoryId  → delete a memory
 *
 * Auth: session user or API key with workspace access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess, canCallerAdminTeam } from '@/lib/team-access';
import { getMemoryStoreForTeam, getMemoryIndexStore } from '@/lib/memory-helper';
import { updateMemory, transitionMemory } from '@buildd/core/memory-write';
import { isMemoryReviewAction } from '@buildd/core/memory-candidates';
import { buildNamespace } from '@buildd/core/knowledge-store';
import { resolveMemoryProjectKey } from '@buildd/core/memory-scope';
import { normalizeProject } from '@buildd/core/project-scope';
import type { MemoryStore } from '@buildd/core/memory-store';

const REVIEW_VERB = { promote: 'promoted', dismiss: 'dismissed', reverified: 'marked re-verified' } as const;

/** One reply for a memory that is missing and one under another project key. */
const notFound = () => NextResponse.json({ error: 'Memory not found' }, { status: 404 });

/**
 * Invariant: these routes reach only the workspace's own memories. The store
 * is team-wide, so the memory must already sit under the workspace's memory
 * project key (resolveMemoryProjectKey). Returns that key, or null when the
 * memory is missing, under another key, or the workspace has no key: callers
 * answer all three with the same 404.
 */
async function ownMemoryKey(memClient: MemoryStore, workspaceId: string, memoryId: string): Promise<string | null> {
  const own = await resolveMemoryProjectKey(workspaceId);
  if (!own) return null;
  const existing = await memClient.get(memoryId).catch(() => null);
  if (!existing || normalizeProject(existing.memory.project) !== own) return null;
  return own;
}

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey, req);
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
 * Review actions change what agents are pushed, so they need an admin of the
 * workspace's team: a team admin/owner session, or an admin-level key of
 * that team.
 */
async function isTeamAdmin(auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>, workspaceId: string, teamId: string): Promise<boolean> {
  if (auth.type === 'session') {
    return !!(await verifyWorkspaceAccess(auth.user.id, workspaceId, 'admin'));
  } else if (auth.type === 'api') {
    return canCallerAdminTeam({ kind: 'account', accountId: auth.account.id, teamId: auth.account.teamId, level: auth.account.level }, teamId);
  }
  return true; // dev mode
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memoryId: string }> },
) {
  const { id, memoryId } = await params;
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

  const action: unknown = body.action;
  if (action !== undefined) {
    if (!isMemoryReviewAction(action)) {
      return NextResponse.json({ error: 'action must be one of promote, dismiss, reverified' }, { status: 400 });
    }
    if (!(await isTeamAdmin(auth, id, memClient.teamId))) {
      return NextResponse.json({ error: 'Only team admins can review memories' }, { status: 403 });
    }
    try {
      const own = await ownMemoryKey(memClient, id, memoryId);
      if (!own) return notFound();
      const data = await transitionMemory(memClient, memoryId, own, action, {
        teamId: memClient.teamId, knowledgeStore: getMemoryIndexStore(), via: 'dashboard:review',
      });
      // The row is ours but was not in a state this action starts from
      // (already promoted, superseded, or not flagged).
      if (!data) {
        return NextResponse.json({ error: `Memory cannot be ${REVIEW_VERB[action]} from its current state` }, { status: 409 });
      }
      return NextResponse.json({ memory: data.memory, supersededIds: data.supersededIds });
    } catch (err) {
      console.error('Memory service error:', err);
      return NextResponse.json({ error: 'Failed to update memory' }, { status: 500 });
    }
  }

  try {
    const own = await ownMemoryKey(memClient, id, memoryId);
    if (!own) return notFound();
    // A memory never moves to another project key from here.
    if (typeof body.project === 'string' && body.project.trim() !== '' && normalizeProject(body.project) !== own) {
      return NextResponse.json({ error: 'project must be this workspace\'s own' }, { status: 400 });
    }
    const data = await updateMemory(memClient, memoryId, {
      type: body.type,
      title: body.title,
      content: body.content,
      files: body.files,
      tags: body.tags || body.concepts,
    }, { teamId: memClient.teamId, knowledgeStore: getMemoryIndexStore(), via: 'dashboard:update' });
    return NextResponse.json({ memory: data.memory, observation: data.memory });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to update memory' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memoryId: string }> },
) {
  const { id, memoryId } = await params;
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

  try {
    if (!(await ownMemoryKey(memClient, id, memoryId))) return notFound();
    await memClient.delete(memoryId);
    // Drop the index chunk too, so recall stops returning a deleted memory.
    await getMemoryIndexStore().delete(buildNamespace(memClient.teamId, 'memory'), [memoryId]).catch(err =>
      console.warn(`[memory-index-delete-failed] memory=${memoryId}`, err),
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 });
  }
}
