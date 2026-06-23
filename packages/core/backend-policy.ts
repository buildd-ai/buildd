// Team-level provider enablement mask.
//
// The per-task backend is resolved through the chain
//   task.backend → mission.defaultBackend → role.defaultBackend → workspace.defaultBackend → 'claude'
// and persisted on the task. This mask sits ABOVE that chain and is applied at
// dispatch time (claim), so it is fully reversible and never mutates the stored
// per-task/role/workspace settings: disable a provider and matching jobs run on
// an enabled one; re-enable and they snap back to their original backend.

export type AgentBackend = 'claude' | 'codex';

/**
 * Mask a resolved backend against the team's enabled-provider list.
 *
 * @param resolved  The backend the resolution chain produced for the task.
 * @param enabled   The team's enabled providers. `null`/`undefined`/`[]` means
 *                  "all enabled" (no mask) — the default for existing teams.
 * @returns The backend to actually run on. If `resolved` is enabled it is
 *          returned unchanged; if disabled, the first enabled provider is used.
 *          If somehow nothing is enabled, `resolved` is returned unchanged
 *          (fail-open — never block all work on a misconfiguration).
 */
export function maskBackend(
  resolved: AgentBackend,
  enabled: AgentBackend[] | null | undefined,
): AgentBackend {
  if (!enabled || enabled.length === 0) return resolved; // no mask
  if (enabled.includes(resolved)) return resolved;        // allowed as-is
  return enabled[0];                                      // disabled → first enabled
}

/** True when the team mask would redirect this backend to a different provider. */
export function isBackendMasked(
  resolved: AgentBackend,
  enabled: AgentBackend[] | null | undefined,
): boolean {
  return maskBackend(resolved, enabled) !== resolved;
}
