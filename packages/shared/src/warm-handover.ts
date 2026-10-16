/**
 * Warm handover is a platform decision, not a team one. buildd answers `repo`
 * unless the workspace opted out; the cloud runner turns reuse on only under
 * CONTAINER_REUSE=1 and raises `repo` to `deps` only under CONTAINER_REUSE_DEPS=1.
 */
export type WarmHandover = 'off' | 'repo' | 'deps';
/** What a workspace may write to gitConfig.warmHandover: an opt-out, or null to clear it. */
export function isWarmHandoverOptOut(value: unknown): value is 'off' | null {
  return value === 'off' || value === null;
}
/**
 * A missing/null workspace value gets the platform default. `repo`/`deps` are
 * opt-ins stored before the team setting was removed; they raise nothing.
 * Malformed policy fails closed.
 */
export function resolveWarmHandover(workspace: unknown): 'off' | 'repo' {
  if (workspace === undefined || workspace === null || workspace === 'repo' || workspace === 'deps') return 'repo';
  return 'off';
}
