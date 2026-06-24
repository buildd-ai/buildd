/**
 * Set the active team (buildd-team cookie) and reload so server components
 * re-resolve the active team and re-scope the namespaced views (missions,
 * workspaces). See docs/specs/team-namespace-scoping.md.
 *
 * Client-only — relies on document/window.
 */
export function switchTeam(teamId: string): void {
  document.cookie = `buildd-team=${teamId};path=/;max-age=${60 * 60 * 24 * 365}`;
  window.location.reload();
}
