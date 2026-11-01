/**
 * Opening a mission's Records sheet in place (Navigation R-23, R-26): the
 * outcome hero's `Open report` and `Supporting reports · n ›` ask the one
 * Records sheet on the page to open, at an artifact or with the primary
 * outcome left out. A link to `?artifact=<id>` stays the no-script fallback
 * and the shareable address (R-2).
 */
export const MISSION_RECORDS_OPEN_EVENT = 'buildd:mission-records-open';

export interface MissionRecordsOpenRequest {
  missionId: string;
  /** Open the viewer at this artifact. */
  artifactId?: string | null;
  /** Leave this artifact out of the list (the primary outcome, for Supporting reports). */
  exclude?: string | null;
}

export function openMissionRecords(request: MissionRecordsOpenRequest): boolean {
  if (typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<MissionRecordsOpenRequest>(MISSION_RECORDS_OPEN_EVENT, { detail: request }));
  if (request.artifactId) {
    const url = new URL(window.location.href);
    url.searchParams.set('artifact', request.artifactId);
    window.history.replaceState(window.history.state, '', url);
  }
  return true;
}
