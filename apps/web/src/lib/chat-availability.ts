/**
 * Can this person start a chat turn right now? (knowledge-base: buildd/design/agent-chat.md,
 * "When no key resolves".)
 *
 * Chat is always on: it is part of buildd, not an option, so there is no
 * switch to read. The only question is whether a chat provider key resolves
 * for this user under the team's key policy. When none does, the Chat entry
 * point still shows; the page renders one inline state that says who can fix
 * it. It never falls back to a subscription seat.
 *
 * `teams.chat_disabled` (the old admin kill switch) is deprecated and unread.
 */
import { cache } from 'react';
import { after } from 'next/server';
import { TTLCache } from './cache';
import { loadInferenceKeyPolicy, type InferenceKeyPolicy } from '@buildd/core/inference-keys';
import { resolveChatModel } from '@/lib/chat/models';
import { FALLBACK_TIER } from '@/lib/chat/routing';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { getUserTeamRole } from '@/lib/team-access';
import { roleHas } from '@/lib/permissions';

export interface ChatAvailabilityDeps {
  keyPolicy(teamId: string): Promise<InferenceKeyPolicy>;
  hasKey(teamId: string, userId: string, keyPolicy: InferenceKeyPolicy): Promise<boolean>;
  role(userId: string, teamId: string): Promise<string | null>;
}

const defaultDeps: ChatAvailabilityDeps = {
  keyPolicy: (teamId) => loadInferenceKeyPolicy(teamId),
  // The same check a turn makes: can the default tier resolve a model for this
  // person (resolveChatModel, which falls back to OpenRouter and applies the
  // team's key policy through resolveInferenceCredential)?
  async hasKey(teamId, userId) {
    const model = await resolveChatModel({ tier: FALLBACK_TIER, teamId, workspaceId: null, userId });
    return model.ok;
  },
  role: (userId, teamId) => getUserTeamRole(userId, teamId),
};

/** Pure core, injectable for tests. Never throws: any failure reads as no key. */
export async function computeChatAvailability(
  userId: string,
  teamId: string | null,
  deps: ChatAvailabilityDeps = defaultDeps,
): Promise<ChatAvailabilityResponse> {
  if (!teamId) return { available: false, reason: 'no_key', canManageTeamKeys: false };
  try {
    const [keyPolicy, role] = await Promise.all([deps.keyPolicy(teamId), deps.role(userId, teamId).catch(() => null)]);
    const canManageTeamKeys = roleHas(role, 'manage_inference_providers');
    if (!(await deps.hasKey(teamId, userId, keyPolicy))) return { available: false, reason: 'no_key', canManageTeamKeys, keyPolicy };
    return { available: true, reason: null, canManageTeamKeys, keyPolicy };
  } catch {
    return { available: false, reason: 'no_key', canManageTeamKeys: false };
  }
}

/**
 * The one availability answer. Per request: the layout (create buttons), the
 * pages (home, /app/chat, settings) and GET /api/chat/availability all read it.
 * The Chat nav entry does not depend on it; it is always there.
 */
export const getChatAvailability = cache(async (userId: string, teamId: string | null) => {
  const value = await computeChatAvailability(userId, teamId);
  if (teamId) remember(userId, teamId, value);
  return value;
});

/**
 * The app shell's read (spec 3ef37387 R-14, R-17). Resolving a model can call
 * the model-policy service and load the OpenRouter catalog, so the layout never
 * waits on it: it takes the last answer for this person and team, and when that
 * is missing or older than a minute it recomputes after the response. Null on a
 * cold cache: the shell then renders as "not yet known" and the client asks
 * /api/chat/availability once, after paint (components/chat/ChatEntry.tsx).
 */
export const CHAT_AVAILABILITY_FRESH_MS = 60_000;

interface Remembered { value: ChatAvailabilityResponse; at: number }
// Kept well past freshness so a stale answer still paints while it refreshes.
const remembered = new TTLCache<Remembered>({ maxSize: 2000, ttlMs: 30 * 60_000 });
const refreshing = new Set<string>();
const keyOf = (userId: string, teamId: string) => `${userId}:${teamId}`;

function remember(userId: string, teamId: string, value: ChatAvailabilityResponse, now = Date.now()): void {
  remembered.set(keyOf(userId, teamId), { value, at: now });
}

export interface PeekDeps {
  /** Runs the refresh once the response is sent (next/server after()). */
  schedule(fn: () => Promise<void>): void;
  compute(userId: string, teamId: string): Promise<ChatAvailabilityResponse>;
  now(): number;
}

const defaultPeekDeps: PeekDeps = {
  schedule: (fn) => after(fn),
  compute: (userId, teamId) => computeChatAvailability(userId, teamId),
  now: () => Date.now(),
};

export function peekChatAvailability(
  userId: string,
  teamId: string,
  deps: PeekDeps = defaultPeekDeps,
): ChatAvailabilityResponse | null {
  const key = keyOf(userId, teamId);
  const hit = remembered.get(key);
  if ((!hit || deps.now() - hit.at > CHAT_AVAILABILITY_FRESH_MS) && !refreshing.has(key)) {
    // Never twice for the same person and team at once.
    refreshing.add(key);
    try {
      deps.schedule(async () => {
        try {
          remember(userId, teamId, await deps.compute(userId, teamId), deps.now());
        } finally {
          refreshing.delete(key);
        }
      });
    } catch {
      // No request scope to defer into: leave it for the next request.
      refreshing.delete(key);
    }
  }
  return hit?.value ?? null;
}

/** Tests only. */
export function clearChatAvailabilityCache(): void {
  remembered.clear();
  refreshing.clear();
}
