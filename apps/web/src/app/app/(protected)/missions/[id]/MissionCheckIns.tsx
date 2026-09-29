'use client';

import { CHECK_INS_EXPLAINER, type LastCheck } from '@/lib/mission-checkins';
import HeartbeatStatusBadge from './HeartbeatStatusBadge';

/**
 * The mission's Check-ins section: the hourly stuck check (internally the
 * mission "heartbeat" schedule) and what its last run found.
 */
export default function MissionCheckIns({ lastCheck }: { lastCheck: LastCheck }) {
  return (
    <div data-testid="mission-check-ins">
      <h2 className="section-label mb-1">Check-ins</h2>
      <p className="text-[11px] text-text-muted">{CHECK_INS_EXPLAINER}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
        <span>Last check:</span>
        <HeartbeatStatusBadge check={lastCheck} />
      </div>
    </div>
  );
}
