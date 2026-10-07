'use client';

/**
 * `?state=workspaces-list`: Settings → Workspaces with illustrative rows. The
 * top list spans two teams (headings on); the bottom one is a single team
 * (no headings) with two inactive workspaces folded away. Covers: rows on
 * the defaults (no chips), each kind of differs chip, cloud with a size, host,
 * any, red PRs and stuck tasks, and a workspace with no tasks at all.
 */
import WorkspacesTable from '../../(protected)/settings/workspaces/WorkspacesTable';
import type { WorkspaceRow } from '../../(protected)/settings/workspaces/list-groups';

const NOW = '2026-06-01T12:00:00.000Z';
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
const DEFAULTS = { gitWorkflow: 'Mission branch', mergePolicy: 'Auto-threshold' };
const TEAMS = [{ id: 'team-a', name: 'Acme' }, { id: 'team-b', name: 'Side projects' }];

const row = (over: Partial<WorkspaceRow> & { id: string; name: string }): WorkspaceRow => ({
  teamId: 'team-a', teamName: 'Acme', differs: [], runsOn: { executor: 'any', size: null },
  lastActivityAt: ago(5), openTasks: 0, health: { stuckTasks: 0, redPrs: 0 }, canEdit: true, canMove: true,
  ...over,
});

const ONE_TEAM: WorkspaceRow[] = [
  row({ id: 'w1', name: 'example-web', runsOn: { executor: 'cloud', size: 'large' }, lastActivityAt: ago(0.3), openTasks: 6, health: { stuckTasks: 0, redPrs: 2 } }),
  row({
    id: 'w2', name: 'example-api', lastActivityAt: ago(3), openTasks: 2,
    differs: [{ key: 'mergePolicy', label: 'Agent review', href: '#' }],
  }),
  row({
    id: 'w3', name: 'example-mobile-app-with-a-long-name', runsOn: { executor: 'host', size: null }, lastActivityAt: ago(50), openTasks: 4,
    differs: [
      { key: 'gitWorkflow', label: 'Direct', href: '#' },
      { key: 'mergePolicy', label: 'Human gate', href: '#' },
      { key: 'ciRetry', label: 'Fixes until CI passes', href: '#' },
    ],
    health: { stuckTasks: 3, redPrs: 0 },
  }),
  row({ id: 'w4', name: 'example-docs', runsOn: { executor: 'cloud', size: 'standard' }, lastActivityAt: ago(24 * 9) }),
  row({ id: 'w5', name: 'example-sandbox', lastActivityAt: ago(24 * 75), canMove: false }),
  row({ id: 'w6', name: 'example-scratch', lastActivityAt: null, canMove: false }),
];

const OTHER_TEAM: WorkspaceRow[] = [
  row({ id: 'w7', name: 'example-blog', teamId: 'team-b', teamName: 'Side projects', lastActivityAt: ago(30), openTasks: 1 }),
  row({ id: 'w8', name: 'example-old-site', teamId: 'team-b', teamName: 'Side projects', lastActivityAt: ago(24 * 40) }),
];

export default function WorkspacesListFixture() {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-12">
        <section>
          <h2 className="section-label mb-1">Your workspaces</h2>
          <WorkspacesTable rows={ONE_TEAM} moveTeams={TEAMS} defaults={DEFAULTS} now={NOW} />
        </section>
        <section>
          <h2 className="section-label mb-1">Your workspaces, two teams</h2>
          <WorkspacesTable rows={[...ONE_TEAM.slice(0, 4), ...OTHER_TEAM]} moveTeams={TEAMS} defaults={DEFAULTS} now={NOW} />
        </section>
      </div>
    </main>
  );
}
