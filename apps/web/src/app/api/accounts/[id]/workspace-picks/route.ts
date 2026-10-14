import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import { listRunnerKeys, replaceRunnerPicks, runnerConsentTeams } from '@/lib/runner-picks';

/**
 * A runner key's workspace picks (spec "One runner for every team you run",
 * R-4), for `buildd login --workspaces` and Settings: read them, or replace
 * them without minting a new key.
 *
 * Session only. `getCurrentUser` reads the signed-in person and never an API
 * key, so a key or an agent run cannot widen what a runner reaches (R-8).
 * Only the person who minted the key may read or change it; anyone else's key
 * reads as not found.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const key = (await listRunnerKeys(user.id)).find((k) => k.id === id);
  if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  const offered = await runnerConsentTeams(user.id);
  return NextResponse.json({
    key,
    offered: offered.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      workspaces: t.workspaces.map((w) => ({ id: w.id, name: w.name, repo: w.repo ?? null, accessMode: w.accessMode ?? null })),
    })),
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const result = await replaceRunnerPicks({ accountId: id, userId: user.id, workspaceIds: body?.workspaceIds });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });
  return NextResponse.json({ ok: true, workspaceIds: result.workspaceIds });
}
