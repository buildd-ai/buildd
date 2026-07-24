/**
 * Render-safe formatting for workspace-migration phase outcomes.
 *
 * The execute/repair APIs return each phase's `detail` as an OBJECT
 * (e.g. { moved: true }, { deletedSecrets: [...] }, { checklistArtifactId }).
 * Rendering an object directly as a React child throws ("Objects are not valid
 * as a React child"), which crashed the migration modal's result screen. These
 * helpers coerce the detail to a short string and normalize the success check.
 */

/** Phase statuses the engine reports as successful (`completed`/`skipped`). */
export function isPhaseSuccess(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'skipped' || status === 'ok';
}

/** Coerce a phase `detail` (object | string | null) into a short display string, or null. */
export function formatOutcomeDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail || null;
  if (typeof detail !== 'object') return String(detail);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key}: ${value.join(', ')}`);
    } else if (typeof value === 'boolean') {
      if (value) parts.push(key);
    } else if (typeof value === 'object') {
      parts.push(key);
    } else {
      const s = String(value);
      if (s) parts.push(`${key}: ${s}`);
    }
  }
  return parts.length ? parts.join('; ') : null;
}

/** Human-friendly phase label ("workspace_team" -> "workspace team"). */
export function formatPhaseLabel(phase: string): string {
  return phase.replace(/_/g, ' ');
}
