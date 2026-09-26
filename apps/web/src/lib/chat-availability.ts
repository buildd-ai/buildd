/**
 * Should this person see agent chat at all? (docs/design/agent-chat.md,
 * "When no key resolves" and the P1 acceptance: with the capability off, or no
 * key resolved, nothing changes — no Chat entry point.)
 *
 * Two gates, cheapest first: the team's `chat` inference capability (off by
 * default, so almost every render stops at one column read), then whether any
 * chat provider key resolves for this user — theirs, the team's, or the
 * environment's outside production. Chat never falls back to a subscription seat.
 */
import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { isInferenceEnabled } from '@buildd/core/inference-policy';
import { INFERENCE_KEY_PROVIDERS, resolveInferenceKey } from '@buildd/core/inference-keys';
import type { ChatAvailabilityResponse } from '@buildd/shared';
import { getUserTeamRole } from '@/lib/team-access';

export interface ChatAvailabilityDeps {
  capabilities(teamId: string): Promise<readonly string[] | null>;
  hasKey(teamId: string, userId: string): Promise<boolean>;
  role(userId: string, teamId: string): Promise<string | null>;
}

const defaultDeps: ChatAvailabilityDeps = {
  async capabilities(teamId) {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { enabledInferenceCapabilities: true } });
    return row?.enabledInferenceCapabilities ?? null;
  },
  async hasKey(teamId, userId) {
    const keys = await Promise.all(
      INFERENCE_KEY_PROVIDERS.map(provider => resolveInferenceKey({ provider, teamId, userId }).catch(() => null)),
    );
    return keys.some(Boolean);
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
    const [caps, role] = await Promise.all([deps.capabilities(teamId), deps.role(userId, teamId).catch(() => null)]);
    const canManageTeamKeys = role === 'owner' || role === 'admin';
    if (!isInferenceEnabled('chat', caps)) return { available: false, reason: 'capability_disabled', canManageTeamKeys };
    if (!(await deps.hasKey(teamId, userId))) return { available: false, reason: 'no_key', canManageTeamKeys };
    return { available: true, reason: null, canManageTeamKeys };
  } catch {
    return { available: false, reason: 'capability_disabled', canManageTeamKeys: false };
  }
}

/** Per request: the layout (nav) and the page (home, /app/chat) share one answer. */
export const getChatAvailability = cache((userId: string, teamId: string | null) => computeChatAvailability(userId, teamId));
