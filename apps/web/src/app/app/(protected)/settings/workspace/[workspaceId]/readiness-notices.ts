import type { HealthItem } from '@/lib/workspace-health';
import type { RepoAccessView } from '@/lib/github-repo-access-store';

export interface ReadinessNotices {
  /** Workspace health rows to render (admins only). */
  health: HealthItem[];
  /** Mount ReadinessCard (repo scan, or the inline repo picker when none is linked). */
  readiness: boolean;
  /** Mount RepoAccessCard (GitHub access state and its fix). */
  repoAccess: boolean;
}

/**
 * Which Readiness rows the workspace settings page shows. The group sits above
 * every setting, so each problem gets one notice, not one per card:
 *
 * - The repo scan reads GitHub through the App. While access is broken it can
 *   only fail ("Could not read the repository") or offer a repo picker beside
 *   the access card's own fix, so the access card speaks alone.
 * - No repo linked at all is the exception for admins: the scan's inline picker
 *   is the fix, and the access card would only repeat "choose a repository".
 */
export function readinessNotices(input: {
  canManage: boolean;
  repoAccessView: RepoAccessView | null;
  healthItems: HealthItem[];
}): ReadinessNotices {
  const { canManage, repoAccessView: view } = input;
  const reason = view && !view.ok ? view.remediation?.reason ?? null : null;
  const pickerFixesIt = reason === 'no_repo';

  return {
    health: canManage ? input.healthItems : [],
    readiness: canManage && (reason === null || pickerFixesIt),
    // Members see a broken row only; admins also see the healthy one with Check connection.
    repoAccess: Boolean(view && (!view.ok || canManage)) && !(canManage && pickerFixesIt),
  };
}
