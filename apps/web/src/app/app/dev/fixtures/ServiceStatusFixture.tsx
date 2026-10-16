'use client';

/**
 * `?state=service-status`: team service status on every surface it shows, from
 * made-up facts run through the real loader (lib/service-status-loader.ts). The
 * real pages need a team with an active root cause in the database. One runner
 * whose sign-in expired, so most of the team's work cannot start, plus a slow
 * platform component. Top to bottom: the Home banner a member sees, the owner's
 * Needs You card, the Health list for a team admin and for a member, and a
 * waiting task's line.
 */
import { DecisionCard } from '../../(protected)/home/DecisionCard';
import { ServiceStatusBanner, ServiceStatusList } from '@/components/service-status/ServiceStatusList';
import { serviceStatusView, type ServiceStatusFacts } from '@/lib/service-status-view';

const AT = '2026-10-12T08:00:00.000Z';
const OWNER = 'owner';
const ADMIN = 'admin';
const MEMBER = 'member';

const FACTS: ServiceStatusFacts = {
  teamId: 'team',
  records: [
    {
      key: 'credential:runner:claude', teamId: 'team', classification: 'credential_expired',
      capability: { kind: 'runner', runnerId: 'runner', provider: 'claude', component: null, workspaceId: null },
      affectedTaskIds: ['t1', 't2', 't3', 't4', 't5', 't6'], firstSeenAt: AT, lastSeenAt: AT, verifiedRestoredAt: null,
    },
    {
      key: 'pattern:stranded_gate:ws', teamId: 'team', classification: 'platform_managed',
      capability: { kind: 'platform', runnerId: null, provider: null, component: 'stranded_gate', workspaceId: 'ws' },
      affectedTaskIds: ['t7'], firstSeenAt: AT, lastSeenAt: AT, verifiedRestoredAt: null,
    },
  ],
  runners: [{ id: 'runner', name: "Dana's MacBook Pro", authType: 'oauth', managedRunner: false, hostRunner: false, createdByUserId: OWNER, recentlyActive: true }],
  members: [{ userId: OWNER, role: 'member' }, { userId: ADMIN, role: 'admin' }, { userId: MEMBER, role: 'member' }],
  tasks: [
    { id: 't1', title: 'Add rate limiting to the public upload endpoint', workspaceId: 'ws', status: 'failed', createdByUserId: MEMBER, hasLiveRun: false },
    { id: 't2', title: 'Fix flaky checkout test', workspaceId: 'ws', status: 'pending', createdByUserId: OWNER, hasLiveRun: false },
    { id: 't3', title: 'Upgrade the date library', workspaceId: 'ws', status: 'failed', createdByUserId: ADMIN, hasLiveRun: false },
    { id: 't4', title: 'Write the release notes for October', workspaceId: 'ws', status: 'failed', createdByUserId: ADMIN, hasLiveRun: false },
    { id: 't5', title: 'Remove the unused feature flags', workspaceId: 'ws', status: 'pending', createdByUserId: OWNER, hasLiveRun: false },
    { id: 't6', title: 'Translate the onboarding emails', workspaceId: 'ws', status: 'failed', createdByUserId: ADMIN, hasLiveRun: false },
    { id: 't7', title: 'Merge the docs refresh', workspaceId: 'ws', status: 'failed', createdByUserId: ADMIN, hasLiveRun: false },
  ],
  teamHasProviderKey: false,
  teamHasSavedSignIn: false,
  recentTaskCount: 30,
};

const owner = serviceStatusView(FACTS, OWNER);
const admin = serviceStatusView(FACTS, ADMIN);
const member = serviceStatusView(FACTS, MEMBER);

function Label({ children }: { children: string }) {
  return <p className="mb-2 mt-8 text-meta text-text-muted first:mt-0">{children}</p>;
}

export default function ServiceStatusFixture() {
  return (
    <main data-testid="service-status-fixture" className="mx-auto max-w-2xl px-4 py-8">
      <Label>Home, a member: the banner</Label>
      {member.banner && <ServiceStatusBanner status={member.banner} href="/app/health" />}
      <Label>Home, the runner owner: the one card</Label>
      <div className="grid gap-4">{owner.needsYou.map(item => <DecisionCard key={item.key} item={item} onDone={() => {}} />)}</div>
      <Label>Health, a team admin</Label>
      <ServiceStatusList statuses={admin.statuses} />
      <Label>Health, a member</Label>
      <ServiceStatusList statuses={member.statuses} />
      <Label>A waiting task's page, a member</Label>
      <ServiceStatusList statuses={member.statuses.filter(s => s.work.some(w => w.taskId === 't1'))} showWork={false} />
    </main>
  );
}
