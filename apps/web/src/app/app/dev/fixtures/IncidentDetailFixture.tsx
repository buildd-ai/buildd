/**
 * `?state=incident-detail`: the incident page body with a sample incident, so it
 * can be audited without a failure_incidents row or the platform operator role.
 */
import IncidentDetail from '../../(protected)/incidents/[id]/IncidentDetail';

const FIRST_SEEN = new Date(Date.now() - 3 * 60 * 60 * 1000);

export default function IncidentDetailFixture() {
  return (
    <IncidentDetail
      incident={{
        title: 'Workers stall after claiming tasks on one runner',
        severity: 'high',
        status: 'open',
        occurrenceCount: 7,
        recurrenceCount: 1,
        firstSeenAt: FIRST_SEEN,
        affectedRefs: { taskIds: ['fx-task-a', 'fx-task-b'], workerIds: [], prNumbers: [101, 102] },
      }}
      workspaceName="Sample workspace"
      fixTask={{ id: 'fx-fix', title: 'Fix stalled claims on the runner', status: 'in_progress' }}
      verdict={{ owner: 'person', reason: 'The same failure came back after a fix landed, so it needs a person to look.' }}
    />
  );
}
