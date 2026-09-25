/**
 * Coerces a request's `defaultBackend` to a stored value: 'claude' | 'codex',
 * anything else (including null) = inherit. Shared by every role write route so
 * they can't drift — the workspace-skill PATCH once ignored the field entirely.
 */
export function normalizeBackend(raw: unknown): 'claude' | 'codex' | null {
  return raw === 'claude' || raw === 'codex' ? raw : null;
}
