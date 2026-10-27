import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { removePasskey } from '@/lib/passkeys/guard';

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/passkeys/[id] { presence? }: remove one of the signed-in
 * person's passkeys. A dashboard session only. Guarded like adding one: with a
 * team that requires passkeys, it needs an assertion by one of theirs.
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { presence?: unknown } | null;
  const r = await removePasskey(who.caller.userId, id, body?.presence);
  if (!r.ok) return NextResponse.json({ error: r.error, ...('code' in r ? { code: r.code } : {}), ...('presence' in r && r.presence ? { presence: r.presence } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true });
}
