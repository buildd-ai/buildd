/**
 * The chat feed's view of the wire contract (docs/design/agent-chat.md,
 * "Objects in the feed").
 *
 * Every buildd tool the chat can call returns `{ data, objects }`: `data` is
 * what the model reads, `objects` are refs the client renders live. A message
 * part stores the ref, never a snapshot, so reopening a conversation shows the
 * object as it is now.
 *
 * The message/part shapes below are the structural subset of AI SDK v7's
 * `UIMessage` the feed reads (`parts`, tool parts with `state`, `approval`),
 * so a `UIMessage` from `useChat` is assignable to `ChatMessage` without the
 * feed importing the SDK.
 */

import {
  CHAT_EVENT_PART_TYPE,
  isBuilddObjectRef,
  type BuilddObjectRef,
  type ChatEventData,
} from '@buildd/shared';
import type { ChatMessage, ChatPart, ChatToolPart } from '@buildd/ai-kit/chat/contract';

// The shared contract (packages/shared/src/chat.ts) is the source of truth.
export {
  CHAT_EVENT_PART_TYPE,
  CHAT_READ_TOOLS,
  chatToolIsRead,
  chatToolNeedsApproval,
  type BuilddObjectKind,
  type BuilddObjectRef,
  type ChatEventData,
  type ChatToolResult,
  type PrObjectRef,
  type QuestionObjectRef,
} from '@buildd/shared';

// The message/part shapes and their guards live in the kit's contract
// (packages/ai-kit/src/chat/contract): buildd's chat is its first consumer.
export {
  isTextPart,
  isToolPart,
  toolNameOf,
  type ChatOtherPart,
  type ChatPart,
  type ChatTextPart,
  type ChatToolPart,
  type ToolApproval,
  type ToolPartState,
} from '@buildd/ai-kit/chat/contract';

export interface ChatMessageMetadata {
  /** ISO timestamp the message was saved. */
  createdAt?: string;
  /** The display name of the human author (user messages). */
  authorName?: string;
  /** The tier the turn ran on (assistant messages). */
  tier?: string;
  /** The workspace the turn was scoped to (streamed; see ChatTurnMetadata). */
  scope?: { id: string; name: string; source: 'pinned' | 'routed' } | null;
  /** Wall-clock duration of the turn in ms. */
  durationMs?: number;
}

export type { ChatMessage } from '@buildd/ai-kit/chat/contract';

export function messageMeta(m: ChatMessage): ChatMessageMetadata {
  return m.metadata && typeof m.metadata === 'object' ? (m.metadata as ChatMessageMetadata) : {};
}

/** A ref the feed can trust: the shared guard, plus a nullable-or-string workspace. */
export function isObjectRef(v: unknown): v is BuilddObjectRef {
  if (!isBuilddObjectRef(v)) return false;
  const ws = (v as { workspaceId?: unknown }).workspaceId;
  return v.id.length > 0 && (ws === null || ws === undefined || typeof ws === 'string');
}

/** The object refs a tool part's output carries, validated; anything malformed is dropped. */
export function objectsOf(part: ChatToolPart): BuilddObjectRef[] {
  if (part.state !== 'output-available') return [];
  const out = part.output as { objects?: unknown } | null | undefined;
  if (!out || typeof out !== 'object' || !Array.isArray(out.objects)) return [];
  return out.objects.filter(isObjectRef);
}

export const refKey = (r: Pick<BuilddObjectRef, 'kind' | 'id'>) => `${r.kind}:${r.id}`;

export function isEventPart(part: ChatPart): part is { type: typeof CHAT_EVENT_PART_TYPE; data: ChatEventData } {
  if (part.type !== CHAT_EVENT_PART_TYPE) return false;
  const d = (part as { data?: unknown }).data as Partial<ChatEventData> | undefined;
  return !!d && typeof d.text === 'string';
}

/** The refs an event part carries, validated. */
export function eventObjects(data: ChatEventData): BuilddObjectRef[] {
  return Array.isArray(data.objects) ? data.objects.filter(isObjectRef) : [];
}
