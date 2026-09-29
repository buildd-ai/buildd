'use client';

import type { LastCheck, LastCheckTone } from '@/lib/mission-checkins';

/** The mission's last check-in, in the owner's words (lib/mission-checkins.ts). */
interface HeartbeatStatusBadgeProps {
  check: LastCheck;
}

const TONE: Record<LastCheckTone, { dot: string; chip: string }> = {
  success: { dot: 'bg-status-success', chip: 'bg-status-success/10 text-status-success border border-status-success/20' },
  warning: { dot: 'bg-status-warning', chip: 'bg-status-warning/10 text-status-warning border border-status-warning/20' },
  error: { dot: 'bg-status-error', chip: 'bg-status-error/10 text-status-error border border-status-error/20' },
  muted: { dot: 'bg-text-muted', chip: 'bg-surface-3 text-text-muted border border-border-default' },
};

export default function HeartbeatStatusBadge({ check }: HeartbeatStatusBadgeProps) {
  const tone = TONE[check.tone];
  return (
    <span
      data-testid="mission-last-check"
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium ${tone.chip}`}
    >
      <span className={`w-1.5 h-1.5 shrink-0 ${tone.dot}`} />
      {check.label}
      {check.at && (
        <span className="opacity-60 ml-0.5">
          {timeAgoShort(check.at)}
        </span>
      )}
    </span>
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
