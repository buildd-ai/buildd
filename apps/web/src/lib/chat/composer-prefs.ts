/**
 * What a new conversation's composer starts with: the person's last workspace
 * and tier in this team (`team_members.chat_composer_prefs`), the tier capped
 * by the team's policy (`teams.chat_default_tier` + `chat_cap_new_session_tier`).
 * An existing conversation keeps its own pin and workspace; this only seeds new ones.
 *
 * Pure. The store is composer-prefs-store.ts.
 */

import { CHAT_TIER_NAMES, isChatTierName, type ChatTierName, type GetComposerPrefsResponse } from '@buildd/shared';

/** Absent key = never chosen; null = chosen "all workspaces" / "auto". */
export interface ComposerPrefs {
  workspaceId?: string | null;
  tier?: ChatTierName | null;
}

export interface TeamTierPolicy {
  /** Null = auto: nothing to cap at. */
  teamDefault: ChatTierName | null;
  capEnabled: boolean;
}

const rank = (t: ChatTierName) => CHAT_TIER_NAMES.indexOf(t);

/**
 * The tier a new conversation starts at. Cap off: the person's last tier. Cap
 * on: never above the team default (reset down, never up); auto counts as
 * above every tier, and a team default of auto caps nothing.
 */
export function resolveInitialTier({ userPref, teamDefault, capEnabled }: {
  userPref: ChatTierName | null | undefined;
  teamDefault: ChatTierName | null;
  capEnabled: boolean;
}): ChatTierName | null {
  const last = userPref ?? null;
  if (!capEnabled || teamDefault === null) return last;
  if (last === null) return teamDefault;
  return rank(last) <= rank(teamDefault) ? last : teamDefault;
}

/** The stored jsonb → prefs, dropping anything this build doesn't know. */
export function parseComposerPrefs(raw: unknown): ComposerPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ComposerPrefs = {};
  if ('workspaceId' in r && (r.workspaceId === null || typeof r.workspaceId === 'string')) out.workspaceId = r.workspaceId;
  if ('tier' in r && (r.tier === null || isChatTierName(r.tier))) out.tier = r.tier;
  return out;
}

export function parseTeamDefaultTier(raw: unknown): ChatTierName | null {
  return isChatTierName(raw) ? raw : null;
}

/** Prefs + policy → the composer's seed. A remembered workspace the person can't see is dropped. */
export function seedComposer(prefs: ComposerPrefs, policy: TeamTierPolicy, workspaceIds: readonly string[]): GetComposerPrefsResponse {
  const out: GetComposerPrefsResponse = { tier: resolveInitialTier({ userPref: prefs.tier, ...policy }) };
  if (prefs.workspaceId === null || (prefs.workspaceId !== undefined && workspaceIds.includes(prefs.workspaceId))) {
    out.workspaceId = prefs.workspaceId;
  }
  return out;
}
