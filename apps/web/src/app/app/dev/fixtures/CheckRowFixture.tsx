'use client';

/**
 * CheckRow in each of its six statuses, and the mission page's Delivery
 * beside Checks (spec 072de598 I-22 to I-24, AC-28 to AC-32). Fixed data; the
 * Skip control is the production one, so it needs a waiver provider.
 */
import CheckRow, { CHECK_STATUSES, type CheckRowStatus } from '@/components/ui/CheckRow';
import { DeliveryChecks } from '@/app/app/(protected)/missions/[id]/MissionChecks';
import { MissionSurfaceAuditWaiverProvider } from '@/app/app/(protected)/missions/[id]/MissionSurfaceAuditWaiver';
import type { DeliveryCheckView, DeliveryView } from '@/lib/mission-delivery-checks';

const DETAIL: Record<CheckRowStatus, { name: string; detail: string }> = {
  passed: { name: 'Visual review', detail: '6 screens · 90df389' },
  running: { name: 'Visual review', detail: '3 screens · 90df389' },
  queued: { name: 'Release', detail: 'after #5701' },
  skipped: { name: 'Visual review', detail: '0 screens · 90df389' },
  failed: { name: 'Release', detail: 'v0.318 · deploy' },
  review: { name: 'Merge into dev', detail: '#5701 · changes requested' },
};

const CHECKS: DeliveryCheckView[] = [
  { key: 'visual', name: 'Visual review', status: 'skipped', stateWord: 'Skipped', detail: '0 screens · 90df389', href: '#screens', skippable: false, current: false, repairs: [] },
  { key: 'merge', name: 'Merge into dev', status: 'running', stateWord: 'In review', detail: '#5701', href: '#pr-5701', skippable: false, current: true, repairs: [] },
  { key: 'release', name: 'Release', status: 'queued', stateWord: 'Queued', detail: 'after #5701', href: '#release', skippable: false, current: false, repairs: [] },
];

const DELIVERY: DeliveryView = {
  line: '5 merged · 1 open · 7 no PR',
  prs: [
    { key: 'a', title: 'Stage meter on Activity rows', number: 5698, href: '#pr-5698', status: 'passed', taskId: 'a' },
    { key: 'b', title: 'Designs in buildd: component screens', number: 5701, href: '#pr-5701', status: 'queued', taskId: 'b' },
  ],
};

export default function CheckRowFixture() {
  return (
    <div data-testid="check-row-fixture" className="min-h-screen bg-surface-1 p-4 text-text-primary md:p-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <ul className="max-w-md overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
          {CHECK_STATUSES.map(s => (
            <li key={s} className="border-t border-[var(--line-soft)] first:border-t-0">
              <CheckRow name={DETAIL[s].name} status={s} detail={DETAIL[s].detail} href={`#${s}`} />
            </li>
          ))}
        </ul>
        <MissionSurfaceAuditWaiverProvider missionId="fixture-mission" waiver={null} missionBranch={false} readonly>
          <DeliveryChecks checks={CHECKS} delivery={DELIVERY} timelineHref="#timeline" />
        </MissionSurfaceAuditWaiverProvider>
      </div>
    </div>
  );
}
