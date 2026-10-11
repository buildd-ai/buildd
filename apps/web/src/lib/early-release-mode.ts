/**
 * The typed config surface for early release (`gitConfig.earlyRelease.mode`,
 * knowledge-base: buildd/design/early-release.md "Rollout & rollback").
 *
 * Kept dependency-free so the workspace settings routes and the stats route can
 * read the mode without loading the dispatcher and the decision pipeline behind
 * it. `early-release-dispatch.ts` re-exports these for its existing callers.
 */
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

export const EARLY_RELEASE_MODES = ['off', 'rule_only', 'rule_and_jev'] as const;
export type EarlyReleaseMode = (typeof EARLY_RELEASE_MODES)[number];

export function isEarlyReleaseMode(value: unknown): value is EarlyReleaseMode {
  return (EARLY_RELEASE_MODES as readonly unknown[]).includes(value);
}

/** Absent / anything unrecognized reads as `'off'` — the workspace must opt in. */
export function resolveEarlyReleaseMode(gitConfig: WorkspaceGitConfig | null | undefined): EarlyReleaseMode {
  const mode = gitConfig?.earlyRelease?.mode;
  return mode === 'rule_only' || mode === 'rule_and_jev' ? mode : 'off';
}

/**
 * Validates a PATCH value for `gitConfig.earlyRelease`. `null` clears it (back
 * to `'off'`); otherwise it must be an object whose `mode`, when present, is one
 * of the exact modes — a typo must never quietly opt a workspace in (or appear
 * to and not). Returns an error message, or null when valid.
 */
export function validateEarlyReleaseConfig(value: unknown): string | null {
  if (value === null) return null;
  const message = `gitConfig.earlyRelease must be { mode: ${EARLY_RELEASE_MODES.map(m => `'${m}'`).join(' | ')} } or null`;
  if (typeof value !== 'object' || Array.isArray(value)) return message;
  const keys = Object.keys(value);
  if (keys.some(k => k !== 'mode')) return message;
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== undefined && !isEarlyReleaseMode(mode)) return message;
  return null;
}
