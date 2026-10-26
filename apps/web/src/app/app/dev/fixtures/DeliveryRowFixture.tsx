'use client';

/**
 * `?state=delivery-row`: DeliveryRow and DeliveryCard (spec 9430a28f r2 R-10,
 * R-11, AC-8..AC-10). Every meter state as a row and as a card from the same
 * item, a delivery being fixed beside the same one once the fix lands, and a
 * long title in a 320px column to show truncation.
 */
import DeliveryRow, { type DeliveryItem } from '@/components/ui/DeliveryRow';
import DeliveryCard from '@/components/ui/DeliveryCard';
import type { StageMeterStage, StageMeterState } from '@/components/ui/StageMeter';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const MIN = 60_000;

const item = (
  id: string, title: string, state: StageMeterState, ago: number,
  extra: { stage?: StageMeterStage; fixRounds?: number; missionTitle?: string | null; failingCheck?: string | null } = {},
): DeliveryItem => ({
  id,
  title,
  href: `/app/tasks/${id}`,
  updatedAt: NOW - ago,
  meter: { state, stage: extra.stage, fixRounds: extra.fixRounds },
  missionTitle: extra.missionTitle === undefined ? 'Honest queue' : extra.missionTitle,
  failingCheck: extra.failingCheck ?? null,
});

const EVERY_STATE: DeliveryItem[] = [
  item('fx-queued', 'Set a runner’s slots from Health', 'queued', 20_000, { missionTitle: null }),
  item('fx-build', 'Stable attempt order', 'build', 2 * MIN, { missionTitle: 'Run progress' }),
  item('fx-fix-build', 'Refresh Honest queue from dev', 'fixing-in-build', 4 * MIN, { fixRounds: 2, failingCheck: 'typecheck failed' }),
  item('fx-verify', 'wsl migrate stops a foreground runner', 'verify', 9 * MIN, { missionTitle: 'Windows runner' }),
  item('fx-fix-verify', 'Pipeline counts match the rows', 'fixing-in-verify', 31 * MIN, { fixRounds: 3, failingCheck: 'CI failed' }),
  item('fx-cant-run', 'Visual QA for the History bars', 'check-cant-run', 2 * 60 * MIN, { stage: 'verify', missionTitle: 'Activity' }),
  item('fx-you', 'Decide the desktop rail order', 'waiting-on-you', 5 * 60 * MIN, { stage: 'verify', missionTitle: 'Activity' }),
  item('fx-deliver', 'DeliveryBar end marks', 'deliver', 3 * 24 * 60 * MIN, { missionTitle: 'Activity' }),
];

const FIXING = item('fx-fixing', 'Refresh Honest queue from dev', 'fixing-in-verify', 4 * MIN, { fixRounds: 1, failingCheck: 'CI failed' });
const FIX_LANDED: DeliveryItem = { ...FIXING, id: 'fx-landed', meter: { state: 'verify' }, updatedAt: NOW - MIN };

const LONG = item(
  'fx-long',
  'Make the Activity row truncate a very long delivery title on one line instead of wrapping it under the meter at 320px',
  'fixing-in-build',
  12 * MIN,
  { fixRounds: 4, missionTitle: 'Activity: see it, don’t read it', failingCheck: 'unit tests failed' },
);

function Label({ children }: { children: string }) {
  return <p className="font-mono text-chip text-text-muted">{children}</p>;
}

export default function DeliveryRowFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 space-y-6">
      <h1 className="font-mono text-chip text-text-primary">DeliveryRow · DeliveryCard</h1>

      <section className="max-w-[390px] space-y-1" data-testid="delivery-row-states">
        <Label>Rows · every meter state</Label>
        <div>{EVERY_STATE.map(d => <DeliveryRow key={d.id} delivery={d} now={NOW} />)}</div>
      </section>

      <section className="max-w-[390px] space-y-1" data-testid="delivery-row-fixing">
        <Label>Being fixed → fix landed (tag returns to the mission)</Label>
        <div>
          <DeliveryRow delivery={FIXING} now={NOW} />
          <DeliveryRow delivery={FIX_LANDED} now={NOW} />
        </div>
      </section>

      <section className="w-[320px] space-y-1" data-testid="delivery-row-long">
        <Label>Long title at 320px</Label>
        <div>
          <DeliveryRow delivery={LONG} now={NOW} />
        </div>
        <DeliveryCard delivery={LONG} now={NOW} />
      </section>

      <section className="space-y-1" data-testid="delivery-card-states">
        <Label>Cards · every meter state (same items as the rows)</Label>
        <div className="grid max-w-3xl grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {EVERY_STATE.map(d => <DeliveryCard key={d.id} delivery={d} now={NOW} />)}
          <DeliveryCard delivery={FIXING} now={NOW} />
          <DeliveryCard delivery={FIX_LANDED} now={NOW} />
        </div>
      </section>
    </div>
  );
}
