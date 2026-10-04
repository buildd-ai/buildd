/**
 * API key level policy.
 *
 * A key can never do more than its creator's current team role allows:
 *   owner / admin → up to `admin`
 *   member        → up to `worker`
 * `trigger` (create-only automation keys) is always available.
 *
 * "Up to admin" is the `manage_team_keys` permission (permissions.ts): the
 * roles that hold it may mint admin-level keys, everyone else stops at worker.
 *
 * Pure functions only — the DB lookup of a caller's role lives in
 * team-access.ts (`getUserTeamRole`).
 */
import { roleHas } from './permission-registry';


export type ApiKeyLevel = 'trigger' | 'worker' | 'admin';
export type TeamRole = 'owner' | 'admin' | 'member';

export const API_KEY_LEVELS: readonly ApiKeyLevel[] = ['trigger', 'worker', 'admin'];

const LEVEL_RANK: Record<ApiKeyLevel, number> = { trigger: 1, worker: 2, admin: 3 };

/** Parse an untrusted level value. Returns null for anything that is not a known level. */
export function parseKeyLevel(value: unknown): ApiKeyLevel | null {
  return typeof value === 'string' && (API_KEY_LEVELS as readonly string[]).includes(value)
    ? (value as ApiKeyLevel)
    : null;
}

/** Highest key level a user with this team role may create. */
export function maxKeyLevelForRole(role: TeamRole): ApiKeyLevel {
  return roleHas(role, 'manage_team_keys') ? 'admin' : 'worker';
}

export function isKeyLevelAllowed(role: TeamRole, level: ApiKeyLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[maxKeyLevelForRole(role)];
}

/** Lower `level` to the highest level `role` allows (used by interactive login flows). */
export function clampKeyLevel(role: TeamRole, level: ApiKeyLevel): ApiKeyLevel {
  return isKeyLevelAllowed(role, level) ? level : maxKeyLevelForRole(role);
}

/** Only roles holding `manage_team_keys` manage a team's keys (regenerate, etc.). */
export function canAdministerTeamKeys(role: TeamRole | null | undefined): boolean {
  return roleHas(role, 'manage_team_keys');
}

/** Plain-language refusal used when a requested level exceeds the caller's role. */
export function keyLevelNotAllowedMessage(role: TeamRole, level: ApiKeyLevel): string {
  return `Your team role (${role}) allows API keys up to ${maxKeyLevelForRole(role)} level; ${level} was requested.`;
}
