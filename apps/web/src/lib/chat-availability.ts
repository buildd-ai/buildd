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
import { loadInferenceKeyPolicy, type InferenceKeyPolicy } from '@buildd/core/inference-keys';
import { resolveChatModel } from '@/lib/chat/models';
import { FALLBACK_TIER } from '@/lib/chat/routing';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { getUserTeamRole } from '@/lib/team-access';
import { roleHas, getTeamPermissionOverrides, type PermissionOverrides } from '@/lib/permissions';

export interface ChatAvailabilityDeps {
  keyPolicy(teamId: string): Promise<InferenceKeyPolicy>;
  hasKey(teamId: string, userId: string, keyPolicy: InferenceKeyPolicy): Promise<boolean>;
  role(userId: string, teamId: string): Promise<string | null>;
  /** The team's permission overrides; defaults to the per-request cached read. */
  overrides?(teamId: string): Promise<PermissionOverrides>;
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
    const canManageTeamKeys = roleHas(role, 'manage_inference_providers', await (deps.overrides ?? getTeamPermissionOverrides)(teamId));
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
export const getChatAvailability = cache((userId: string, teamId: string | null) => computeChatAvailability(userId, teamId));
