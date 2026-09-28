import { NextRequest, NextResponse } from 'next/server';
import type { CreateChatDirectiveRequest, ListChatDirectivesResponse } from '@buildd/shared';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { requireChatCaller } from '@/lib/chat/session';
import { createDirective, listDirectives, listScopableWorkspaces, loadDirectiveCard, markDirectiveCard, toDirectiveDTO } from '@/lib/chat/directives-store';
import { normalizeDirectiveText } from '@buildd/core/chat-directives';
import { checkCard, checkText, checkWorkspace } from './validate';

/**
 * GET  /api/chat/directives → ListChatDirectivesResponse (the caller's own rules, newest first)
 * POST /api/chat/directives { text, workspaceId?, from? } → { directive, existed }
 *
 * Standing rules (packages/core/chat-directives.ts). Personal: session only,
 * and every query is keyed by the caller. `from` is the card that proposed the
 * rule; saving answers it.
 */

export async function GET(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  const [rows, wsIds] = await Promise.all([listDirectives(r.caller.user.id), getUserWorkspaceIds(r.caller.user.id)]);
  const reachable = new Set(wsIds);
  const body: ListChatDirectivesResponse = {
    // A workspace the person left keeps their rule, but not the workspace's name.
    directives: rows.map(d => toDirectiveDTO(d.row, d.row.workspaceId && reachable.has(d.row.workspaceId) ? d.workspaceName : null)),
    workspaces: await listScopableWorkspaces(wsIds),
  };
  return NextResponse.json(body);
}

export async function POST(req: NextRequest) {
  const r = await requireChatCaller(req);
  if ('response' in r) return r.response;
  let body: CreateChatDirectiveRequest;
  try { body = (await req.json()) ?? {}; } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const t = checkText(body.text);
  if ('response' in t) return t.response;
  const w = await checkWorkspace(r.caller, body.workspaceId);
  if ('response' in w) return w.response;
  const from = body.from !== undefined ? await checkCard(r.caller, body.from) : null;
  if (from && 'response' in from) return from.response;

  // Saving from a card saves what the card proposed, in a scope it offered.
  // A message with no card (not yet persisted, or never had one) still saves,
  // as an ordinary rule from the person, and answers nothing.
  const proposed = from ? await loadDirectiveCard(from.conversationId, from.messageId) : null;
  if (proposed) {
    if (normalizeDirectiveText(proposed.text) !== t.text) {
      return NextResponse.json({ error: 'text_mismatch', message: 'That is not the rule the card proposed.' }, { status: 400 });
    }
    if (w.workspaceId !== null && w.workspaceId !== proposed.workspace?.id) {
      return NextResponse.json({ error: 'scope_mismatch', message: 'The card did not offer that workspace.' }, { status: 400 });
    }
  }
  const card = proposed ? from : null;

  const res = await createDirective({
    userId: r.caller.user.id,
    text: t.text,
    workspaceId: w.workspaceId,
    source: card ? 'chat' : 'settings',
    sourceMessageId: card?.messageId ?? null,
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'directive_limit', message: 'You have the most rules you can keep. Remove one in Settings first.' }, { status: 409 });
  }
  if (card) await markDirectiveCard(card.conversationId, card.messageId, {
    status: 'saved', directiveId: res.row.id, savedScope: res.row.workspaceId ? 'workspace' : 'everywhere',
  }).catch(() => false);
  return NextResponse.json({ directive: toDirectiveDTO(res.row, null), existed: res.existed }, { status: res.existed ? 200 : 201 });
}
