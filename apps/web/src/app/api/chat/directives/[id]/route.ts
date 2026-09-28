import { NextRequest, NextResponse } from 'next/server';
import type { UpdateChatDirectiveRequest } from '@buildd/shared';
import { requireChatCaller } from '@/lib/chat/session';
import { deleteDirective, toDirectiveDTO, updateDirective } from '@/lib/chat/directives-store';
import { checkText, checkWorkspace } from '../validate';

/**
 * PATCH  /api/chat/directives/[id] { text?, workspaceId? } → { directive }
 * DELETE /api/chat/directives/[id]
 *
 * The caller's own rule only: the store's WHERE carries their user id, so
 * someone else's rule is a 404, never an edit.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  let body: UpdateChatDirectiveRequest;
  try { body = (await req.json()) ?? {}; } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const patch: { text?: string; workspaceId?: string | null } = {};
  if (body.text !== undefined) {
    const t = checkText(body.text);
    if ('response' in t) return t.response;
    patch.text = t.text;
  }
  if (body.workspaceId !== undefined) {
    const w = await checkWorkspace(r.caller, body.workspaceId);
    if ('response' in w) return w.response;
    patch.workspaceId = w.workspaceId;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

  const row = await updateDirective(r.caller.user.id, id, patch);
  if (!row) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  return NextResponse.json({ directive: toDirectiveDTO(row, null) });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const { id } = await ctx.params;
  const ok = await deleteDirective(r.caller.user.id, id);
  if (!ok) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
