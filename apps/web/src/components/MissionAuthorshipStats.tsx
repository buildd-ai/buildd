import type { MissionAuthorshipHealth } from '@buildd/core/mission-helpers';
import { DerivedMetricDisplay } from './DerivedMetricDisplay';

/**
 * The owner's steering cost, at a glance: how much of a mission's countable
 * work a human had to file directly, and how much leaked in after the
 * mission was marked done. Shared between the mission list card and the
 * mission detail header — see `computeMissionAuthorshipHealth`.
 */
export function MissionAuthorshipStats({ health }: { health: MissionAuthorshipHealth }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] md:text-[10px] uppercase tracking-wide text-text-muted">
      <span title="Share of countable tasks (work + bookkeeping; CI/reviewer/conflict retries excluded) filed directly by a person rather than an agent">
        Human{' '}
        <DerivedMetricDisplay
          metric={health.humanShare}
          renderValue={v => `${v.pct}% (${v.atStart} at start, ${v.midFlight} mid-flight)`}
        />
      </span>
      <span title="Countable tasks filed after this mission completed that still reference it">
        Follow-ups{' '}
        <DerivedMetricDisplay metric={health.followups} renderValue={v => String(v.count)} />
      </span>
    </span>
  );
}
