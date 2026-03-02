/**
 * Individual memory operations — proxies to memory service.
 *
 * PATCH  /api/workspaces/:id/memory/:memoryId  → update a memory
 * DELETE /api/workspaces/:id/memory/:memoryId  → delete a memory
 *
 * Auth: session user or API key with workspace access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { MemoryClient } from '@buildd/core/memory-client';

function getMemoryClient(): MemoryClient | null {
  const url = process.env.MEMORY_API_URL;
  const key = process.env.MEMORY_API_KEY;
  if (!url || !key) return null;
  return new MemoryClient(url, key);
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

  const memClient = getMemoryClient();
  if (!memClient) {
    return NextResponse.json({ error: 'Memory service not configured' }, { status: 503 });
  }

  const body = await req.json();

  try {
    const data = await memClient.update(memoryId, {
      type: body.type,
      title: body.title,
      content: body.content,
      files: body.files,
      tags: body.tags || body.concepts,
      project: body.project,
    });
    return NextResponse.json({ memory: data.memory, observation: data.memory });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to update memory' }, { status: 502 });
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

  const memClient = getMemoryClient();
  if (!memClient) {
    return NextResponse.json({ error: 'Memory service not configured' }, { status: 503 });
  }

  try {
    await memClient.delete(memoryId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Memory service error:', err);
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 502 });
  }
}
