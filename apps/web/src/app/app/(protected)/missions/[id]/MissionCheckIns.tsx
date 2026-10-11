'use client';

import { CHECK_INS_EXPLAINER, type LastCheck, type LastCheckTone } from '@/lib/mission-checkins';
import StatePill from '@/components/ui/StatePill';
import type { StateKey } from '@/components/ui/states';

/** A check-in's tone, drawn with the state that shares its hue and glyph. */
const CHECK_STATE: Record<LastCheckTone, StateKey> = {
  success: 'landed',
  warning: 'waiting',
  error: 'failed',
  muted: 'ready',
};

/** The mission's last check-in, in the owner's words (lib/mission-checkins.ts). */
export function LastCheckPill({ check }: { check: LastCheck }) {
  return (
    <StatePill
      state={CHECK_STATE[check.tone]}
      label={check.label}
      title={check.label}
      data-testid="mission-last-check"
      trailing={check.at ? timeAgoShort(check.at) : undefined}
    />
  );
}

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
        <LastCheckPill check={lastCheck} />
      </div>
    </div>
  );
}

function timeAgoShort(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
