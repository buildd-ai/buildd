/**
 * Storage for chat directives (the person's standing rules). Every read and
 * write is keyed by the caller's user id in its WHERE clause, so one person
 * can never read, edit or remove another's rules. The pure rules (caps, the
 * turn block) are in @buildd/core/chat-directives.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { chatDirectives, conversationMessages, workspaces, type ChatDirectiveRow } from '@buildd/core/db/schema';
import { MAX_DIRECTIVES_PER_USER, type StandingRule } from '@buildd/core/chat-directives';
import { CHAT_DIRECTIVE_PART_TYPE, type ChatDirectiveCandidateData, type ChatDirectiveDTO } from '@buildd/shared';

export function toDirectiveDTO(r: ChatDirectiveRow, workspaceName: string | null): ChatDirectiveDTO {
  return {
    id: r.id,
    text: r.text,
    workspaceId: r.workspaceId,
    workspaceName,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The person's rules, newest first, with each workspace's name. */
export async function listDirectives(userId: string): Promise<Array<{ row: ChatDirectiveRow; workspaceName: string | null }>> {
  const rows = await db
    .select({ row: chatDirectives, workspaceName: workspaces.name })
    .from(chatDirectives)
    .leftJoin(workspaces, eq(workspaces.id, chatDirectives.workspaceId))
    .where(eq(chatDirectives.userId, userId))
    .orderBy(desc(chatDirectives.createdAt))
    .limit(MAX_DIRECTIVES_PER_USER);
  return rows.map(r => ({ row: r.row, workspaceName: r.workspaceName ?? null }));
}

/** Workspaces a rule can be scoped to: the ones the person can reach, by name. */
export async function listScopableWorkspaces(workspaceIds: readonly string[]): Promise<Array<{ id: string; name: string }>> {
  if (workspaceIds.length === 0) return [];
  return db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
    .where(inArray(workspaces.id, [...workspaceIds]))
    .orderBy(asc(workspaces.name))
    .limit(200);
}

/** What a turn loads: text, scope and age only. Empty on any failure: a turn never fails for its rules. */
export async function loadStandingRules(userId: string): Promise<StandingRule[]> {
  try {
    return await db
      .select({ text: chatDirectives.text, workspaceId: chatDirectives.workspaceId, createdAt: chatDirectives.createdAt })
      .from(chatDirectives)
      .where(eq(chatDirectives.userId, userId))
      .orderBy(desc(chatDirectives.createdAt))
      .limit(MAX_DIRECTIVES_PER_USER);
  } catch (e) {
    console.error('[chat] failed to load standing rules:', e);
    return [];
  }
}

export type CreateDirectiveResult =
  | { ok: true; row: ChatDirectiveRow; existed: boolean }
  | { ok: false; reason: 'limit' };

/** Postgres unique_violation on the one-copy-per-scope constraint. */
export function isDuplicateRule(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const c = e?.cause ?? e;
  return c?.code === '23505' && (!c.constraint || c.constraint === 'chat_directives_user_scope_text_unique');
}

function sameRule(userId: string, text: string, workspaceId: string | null) {
  const scope = workspaceId === null
    ? sql`${chatDirectives.workspaceId} is null`
    : eq(chatDirectives.workspaceId, workspaceId);
  return and(eq(chatDirectives.userId, userId), eq(chatDirectives.text, text), scope);
}

/**
 * Save a rule, race-free. One statement inserts only while the person holds
 * fewer than MAX_DIRECTIVES_PER_USER rules, and ON CONFLICT DO NOTHING on the
 * one-copy-per-scope constraint makes a double tap (or a card answered on two
 * devices) a no-op. When nothing was inserted the existing copy wins; with no
 * copy, the cap refused it.
 */
export async function createDirective(input: {
  userId: string;
  text: string;
  workspaceId: string | null;
  source: 'chat' | 'settings';
  sourceMessageId?: string | null;
}): Promise<CreateDirectiveResult> {
  const inserted = await db.execute(sql`
    insert into chat_directives (user_id, workspace_id, text, source, source_message_id)
    select ${input.userId}::uuid, ${input.workspaceId}::uuid, ${input.text}, ${input.source}, ${input.sourceMessageId ?? null}::uuid
    where (select count(*) from chat_directives where user_id = ${input.userId}::uuid) < ${MAX_DIRECTIVES_PER_USER}
    on conflict do nothing
    returning id`);
  const id = (inserted.rows[0] as { id?: string } | undefined)?.id;
  if (id) {
    const [row] = await db.select().from(chatDirectives).where(and(eq(chatDirectives.id, id), eq(chatDirectives.userId, input.userId))).limit(1);
    if (row) return { ok: true, row, existed: false };
  }
  const [same] = await db.select().from(chatDirectives).where(sameRule(input.userId, input.text, input.workspaceId)).limit(1);
  if (same) return { ok: true, row: same, existed: true };
  return { ok: false, reason: 'limit' };
}

/**
 * Edit the caller's own rule. Null when it is not theirs (or gone);
 * 'duplicate' when the edit would copy another of their rules in the same
 * scope (the unique constraint refuses it and nothing changes).
 */
export async function updateDirective(userId: string, id: string, patch: { text?: string; workspaceId?: string | null }): Promise<ChatDirectiveRow | null | 'duplicate'> {
  try {
    const [row] = await db.update(chatDirectives)
      .set({
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(chatDirectives.id, id), eq(chatDirectives.userId, userId)))
      .returning();
    return row ?? null;
  } catch (e) {
    if (isDuplicateRule(e)) return 'duplicate';
    throw e;
  }
}

/**
 * The directive card on one stored assistant message, or null (no such
 * message in that conversation, or no card on it). The caller has already
 * checked the conversation is theirs.
 */
export async function loadDirectiveCard(conversationId: string, messageId: string): Promise<ChatDirectiveCandidateData | null> {
  const [row] = await db.select({ parts: conversationMessages.parts }).from(conversationMessages)
    .where(and(
      eq(conversationMessages.id, messageId),
      eq(conversationMessages.conversationId, conversationId),
      eq(conversationMessages.role, 'assistant'),
    ))
    .limit(1);
  const part = row?.parts.find(p => p.type === CHAT_DIRECTIVE_PART_TYPE) as { data?: ChatDirectiveCandidateData } | undefined;
  return part?.data && typeof part.data.text === 'string' ? part.data : null;
}

/** Remove the caller's own rule. False when it is not theirs (or gone). */
export async function deleteDirective(userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(chatDirectives)
    .where(and(eq(chatDirectives.id, id), eq(chatDirectives.userId, userId)))
    .returning({ id: chatDirectives.id });
  return rows.length > 0;
}

/**
 * Answer the card on a stored assistant message: merge `patch` into the data
 * of its directive part, in one statement. The caller has already checked the
 * conversation is theirs; the conversation id is in the WHERE too.
 */
export async function markDirectiveCard(
  conversationId: string,
  messageId: string,
  patch: Pick<ChatDirectiveCandidateData, 'status' | 'directiveId' | 'savedScope'>,
): Promise<boolean> {
  const rows = await db.update(conversationMessages)
    .set({
      parts: sql`(
        select coalesce(jsonb_agg(
          case when p->>'type' = ${CHAT_DIRECTIVE_PART_TYPE}
            then jsonb_set(p, '{data}', coalesce(p->'data', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)
            else p end
          order by i), '[]'::jsonb)
        from jsonb_array_elements(${conversationMessages.parts}) with ordinality as e(p, i)
      )`,
    })
    .where(and(
      eq(conversationMessages.id, messageId),
      eq(conversationMessages.conversationId, conversationId),
      eq(conversationMessages.role, 'assistant'),
      sql`${conversationMessages.parts} @> ${JSON.stringify([{ type: CHAT_DIRECTIVE_PART_TYPE }])}::jsonb`,
    ))
    .returning({ id: conversationMessages.id });
  return rows.length > 0;
}
