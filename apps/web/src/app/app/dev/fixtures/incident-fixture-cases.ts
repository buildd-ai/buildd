/**
 * `?state=incident-detail&case=<case>`: the incident page (IncidentDetail +
 * IncidentRecoveryPanel) in each recovery state, then `surfaces`, the task-page
 * and mission-page notices. The visual-QA clone scrubs failure_incidents
 * (scripts/qa/scrub-pii.sql), so /app/incidents/:id has no row to show there;
 * scripts/qa/plans/incident-detail.json captures these instead.
 */
export const INCIDENT_FIXTURE_RECOVERY_CASES = ['waiting', 'repairing', 'retrying', 'retry-exhausted', 'decision', 'inconclusive', 'recovered'] as const;
export type IncidentFixtureRecoveryCase = (typeof INCIDENT_FIXTURE_RECOVERY_CASES)[number];

export const INCIDENT_FIXTURE_CASE_NAMES = [...INCIDENT_FIXTURE_RECOVERY_CASES, 'surfaces'] as const;
