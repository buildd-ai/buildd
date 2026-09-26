/**
 * The agent-chat opener for the demo (docs/design/agent-chat.md): a conversation
 * seeded with the approval card open, and the t=0 `mission_create` event that
 * confirms it — the proposing tool part turns `output-available` carrying the
 * mission ref, exactly as the chat route stores a confirmed filing, and the
 * mission records the conversation it came from.
 *
 * Deterministic and model-free: the turns are story data, not a model call. The
 * provider key is synthetic and only makes the chat entry points appear.
 */
import type { LocalDb } from '../../../packages/core/db/local-client';
import { schema as s, sql, eq } from '../../../packages/core/db/local-client';
import { createHash } from 'crypto';
import { relTime, type Entity, type IdMap, type Story } from './story';

/**
 * The chat route's approval input hash (apps/web/src/lib/chat/approvals.ts),
 * restated here so the demo tooling never imports the app's DB client; the
 * test pins the two to the same output.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
export function demoInputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** serve.sh's throwaway ENCRYPTION_KEY: the key is sealed with the value the demo server reads. */
export const DEMO_ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

/** `{{KEY}}` anywhere in a string → the seeded UUID of that dataset key. Pure; unknown keys throw. */
export function fillKeys<T>(value: T, ids: Pick<IdMap, 'get'>): T {
  if (typeof value === 'string') return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, k) => ids.get(k)) as T;
  if (Array.isArray(value)) return value.map((v) => fillKeys(v, ids)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillKeys(v, ids)])) as T;
  }
  return value;
}

type Part = { type: string; [k: string]: unknown };

/**
 * The confirmed message: the approval part becomes the filed call (approved,
 * with the mission ref in its output) and the agent's one-line follow-up comes
 * after it. Pure; a part that isn't the approval is left alone.
 */
export function confirmedParts(
  parts: readonly Part[],
  toolCallId: string,
  onConfirm: { summary: string; data: string; objects: unknown[]; followUp?: string },
): Part[] {
  let found = false;
  const out = parts.map((p) => {
    if (p.toolCallId !== toolCallId) return p;
    found = true;
    const approval = (p.approval ?? {}) as { id?: string };
    return {
      ...p,
      state: 'output-available',
      approval: { id: approval.id, approved: true },
      output: { data: onConfirm.data, objects: onConfirm.objects, summary: onConfirm.summary },
    };
  });
  if (!found) throw new Error(`[demo] no tool part ${toolCallId} to confirm`);
  return onConfirm.followUp ? [...out, { type: 'text', text: onConfirm.followUp }] : out;
}

function conversationOf(story: Story, key: string): Entity {
  const c = (story.chat?.conversations ?? []).find((x: Entity) => x.key === key);
  if (!c) throw new Error(`[demo] story has no conversation "${key}"`);
  return c;
}

export function registerChatKeys(story: Story, ids: IdMap) {
  for (const c of story.chat?.conversations ?? []) {
    ids.register(c.key);
    for (const m of c.messages ?? []) ids.register(m.key);
  }
}

/** Seed time: turn chat on for the team, store the synthetic key, write the conversation up to the open approval. */
export async function seedChat(db: LocalDb, story: Story, ids: IdMap, anchorMs: number) {
  const chat = story.chat;
  if (!chat) return;
  const teamId = ids.get(story.team.key);
  if (chat.capabilities?.length) {
    await db.update(s.teams).set({ enabledInferenceCapabilities: chat.capabilities } as any).where(eq(s.teams.id, teamId));
  }
  if (chat.providerKey) {
    process.env.ENCRYPTION_KEY ??= DEMO_ENCRYPTION_KEY;
    const { encrypt } = await import('../../../packages/core/secrets/crypto');
    await db.insert(s.secrets).values({
      teamId, purpose: 'inference_key', label: chat.providerKey.provider,
      encryptedValue: encrypt(chat.providerKey.value), healthStatus: 'healthy',
    } as any);
  }
  for (const c of chat.conversations ?? []) {
    const created = relTime(anchorMs, c._createdAgo, 5 * 60_000);
    const messages: Entity[] = c.messages ?? [];
    const last = messages.length ? relTime(anchorMs, messages[messages.length - 1]._at) : created;
    await db.insert(s.conversations).values({
      id: ids.get(c.key), teamId, workspaceId: c.workspaceId ? ids.get(c.workspaceId) : null,
      createdByUserId: ids.get(c.createdByUserId), title: c.title ?? null, titleSource: c.titleSource ?? 'auto',
      agentRoleSlug: c.agentRoleSlug ?? 'organizer', lastMessageAt: last, createdAt: created,
    } as any);
    for (const [i, m] of messages.entries()) {
      // Seconds apart within the same minute, so the order is the story's.
      const at = new Date(relTime(anchorMs, m._at).getTime() + i * 1000);
      await db.insert(s.conversationMessages).values({
        id: ids.get(m.key), conversationId: ids.get(c.key), role: m.role, parts: fillKeys(m.parts, ids),
        authorUserId: m.role === 'user' ? ids.get(c.createdByUserId) : null, tier: m.tier ?? null, createdAt: at,
      } as any);
    }
    if (c.approval) {
      const msg = messages.find((m) => m.key === c.approval.messageKey);
      const part = (msg?.parts ?? []).find((p: Part) => p.toolCallId === c.approval.toolCallId);
      await db.insert(s.conversationApprovals).values({
        approvalId: c.approval.approvalId, conversationId: ids.get(c.key), messageId: ids.get(c.approval.messageKey),
        toolCallId: c.approval.toolCallId, toolName: c.approval.toolName, inputHash: demoInputHash(fillKeys(part?.input, ids)),
        proposedForUserId: ids.get(c.createdByUserId), status: 'pending', createdAt: relTime(anchorMs, msg?._at),
      } as any);
    }
  }
}

/**
 * The t=0 event: the user confirmed. The mission records its conversation, the
 * approval row is decided once, and the proposing part becomes the filed call.
 * Returns the conversation id for the `conversation:updated` ping.
 */
export async function confirmChatApproval(db: LocalDb, story: Story, ids: IdMap, conversationKey: string, missionKey: string, at: Date): Promise<string> {
  const c = conversationOf(story, conversationKey);
  const conversationId = ids.get(c.key);
  await db.update(s.missions).set({ conversationId } as any).where(eq(s.missions.id, ids.get(missionKey)));
  if (!c.approval || !c._onConfirm) return conversationId;
  const messageId = ids.get(c.approval.messageKey);
  const [row] = await db.select({ parts: s.conversationMessages.parts }).from(s.conversationMessages).where(eq(s.conversationMessages.id, messageId));
  if (!row) throw new Error(`[demo] conversation message ${c.approval.messageKey} missing`);
  const onConfirm = fillKeys(c._onConfirm, ids);
  const parts = confirmedParts(row.parts as Part[], c.approval.toolCallId, onConfirm);
  await db.update(s.conversationMessages).set({ parts } as any).where(eq(s.conversationMessages.id, messageId));
  await db.execute(sql`
    update conversation_approvals set status = 'approved', decided_at = ${at}, result = ${JSON.stringify(onConfirm)}::jsonb
    where approval_id = ${c.approval.approvalId} and status = 'pending'`);
  await db.update(s.conversations).set({ lastMessageAt: at } as any).where(eq(s.conversations.id, conversationId));
  return conversationId;
}
