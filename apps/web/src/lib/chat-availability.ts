/**
 * Should this person see agent chat at all? (docs/design/agent-chat.md,
 * "When no key resolves" and the P1 acceptance: with the capability off, or no
 * key resolved, nothing changes — no Chat entry point.)
 *
 * Two gates, cheapest first: an admin switched chat off for the team
 * (`teams.chatDisabled`), then whether any chat provider key resolves for this
 * user under the team's key policy. Chat is on whenever a key resolves; there
 * is no separate step to turn it on. It never falls back to a subscription seat.
 */
import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { loadInferenceKeyPolicy, type InferenceKeyPolicy } from '@buildd/core/inference-keys';
import { resolveChatModel } from '@/lib/chat/models';
import { FALLBACK_TIER } from '@/lib/chat/routing';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { getUserTeamRole } from '@/lib/team-access';

export interface ChatAvailabilityDeps {
  chatDisabled(teamId: string): Promise<boolean>;
  keyPolicy(teamId: string): Promise<InferenceKeyPolicy>;
  hasKey(teamId: string, userId: string, keyPolicy: InferenceKeyPolicy): Promise<boolean>;
  role(userId: string, teamId: string): Promise<string | null>;
}

const defaultDeps: ChatAvailabilityDeps = {
  async chatDisabled(teamId) {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { chatDisabled: true } });
    return row ? row.chatDisabled === true : true;
  },
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

/** Pure core, injectable for tests. Never throws: any failure reads as unavailable. */
export async function computeChatAvailability(
  userId: string,
  teamId: string | null,
  deps: ChatAvailabilityDeps = defaultDeps,
): Promise<ChatAvailabilityResponse> {
  if (!teamId) return { available: false, reason: 'capability_disabled', canManageTeamKeys: false };
  try {
    const [disabled, role] = await Promise.all([deps.chatDisabled(teamId), deps.role(userId, teamId).catch(() => null)]);
    const canManageTeamKeys = role === 'owner' || role === 'admin';
    if (disabled) return { available: false, reason: 'capability_disabled', canManageTeamKeys };
    const keyPolicy = await deps.keyPolicy(teamId);
    if (!(await deps.hasKey(teamId, userId, keyPolicy))) return { available: false, reason: 'no_key', canManageTeamKeys, keyPolicy };
    return { available: true, reason: null, canManageTeamKeys, keyPolicy };
  } catch {
    return { available: false, reason: 'capability_disabled', canManageTeamKeys: false };
  }
}

/**
 * The one availability answer. Per request: the layout (nav), the pages (home,
 * /app/chat, settings) and GET /api/chat/availability all read it.
 */
export const getChatAvailability = cache((userId: string, teamId: string | null) => computeChatAvailability(userId, teamId));
