'use client';

/**
 * `?state=runner-keys`: Settings → Connected apps → Runners with fake keys
 * and a local api (nothing is sent anywhere). Shows what a real account
 * rarely has all at once: a runner whose picks span two teams, one pick a
 * team admin removed, one out of reach, a long workspace name that has to
 * wrap at 320px, a key made before picks, and the admin list of runners from
 * other teams with Remove.
 */
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import RunnerKeysSection, { type RunnerKeysApi } from '../../(protected)/settings/connections/RunnerKeysSection';
import type { ForeignRunner, RunnerKeySummary } from '@/lib/runner-picks';

const pick = (teamId: string, teamName: string, workspaceId: string, workspaceName: string, over: { reachable?: boolean; removedByAdmin?: boolean } = {}) => ({
  workspaceId, workspaceName, teamId, teamName, reachable: over.reachable ?? true, removedByAdmin: over.removedByAdmin ?? false,
});

const LONG_NAME = 'customer-notifications-and-billing-reconciliation-service';

const KEYS: RunnerKeySummary[] = [
  {
    id: 'fixture-runner-laptop', name: 'Laptop', apiKeyPrefix: 'bld_fx01', level: 'worker', homeTeamName: 'Acme Platform',
    createdAt: '2026-09-20T09:00:00Z', lastUsedAt: '2026-10-09T10:40:00Z',
    picks: [
      pick('fixture-team-a', 'Acme Platform', 'fixture-ws-api', 'api'),
      pick('fixture-team-a', 'Acme Platform', 'fixture-ws-long', LONG_NAME),
      pick('fixture-team-a', 'Acme Platform', 'fixture-ws-payments', 'payments', { reachable: false, removedByAdmin: true }),
      pick('fixture-team-b', 'Side projects', 'fixture-ws-blog', 'blog'),
      pick('fixture-team-b', 'Side projects', 'fixture-ws-site', 'site', { reachable: false }),
    ],
  },
  {
    id: 'fixture-runner-desktop', name: 'Build box', apiKeyPrefix: 'bld_fx02', level: 'worker', homeTeamName: 'Acme Platform',
    createdAt: '2026-08-02T09:00:00Z', lastUsedAt: '2026-10-08T18:00:00Z', picks: null,
  },
];

const FOREIGN: ForeignRunner[] = [
  { accountId: 'fixture-foreign-1', accountName: 'Studio laptop', ownerName: 'Sam Example', homeTeamName: 'Design guild', workspaceId: 'fixture-ws-api', workspaceName: 'api', teamName: 'Acme Platform' },
  { accountId: 'fixture-foreign-2', accountName: 'CI runner', ownerName: 'Alex Example', homeTeamName: 'Partner team', workspaceId: 'fixture-ws-long', workspaceName: LONG_NAME, teamName: 'Acme Platform' },
];

const localApi: RunnerKeysApi = {
  async disconnect() { return { ok: true }; },
  async removeForeign() { return { ok: true }; },
};

export default function RunnerKeysFixture() {
  return (
    <div className="min-h-screen bg-surface-1">
      <SettingsPage title="Connected apps" description="Apps you connected to buildd.">
        <RunnerKeysSection keys={KEYS} foreign={FOREIGN} api={localApi} />
      </SettingsPage>
    </div>
  );
}
