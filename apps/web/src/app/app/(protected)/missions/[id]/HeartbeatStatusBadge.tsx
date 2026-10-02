'use client';

import type { LastCheck } from '@/lib/mission-checkins';
import Chip from '@/components/ui/Chip';

/** The mission's last check-in, in the owner's words (lib/mission-checkins.ts). */
interface HeartbeatStatusBadgeProps {
  check: LastCheck;
}

export default function HeartbeatStatusBadge({ check }: HeartbeatStatusBadgeProps) {
  // LastCheckTone (success | warning | error | muted) is a subset of ChipTone.
  return (
    <Chip
      tone={check.tone}
      variant="soft"
      data-testid="mission-last-check"
      trailing={check.at ? timeAgoShort(check.at) : undefined}
    >
      {check.label}
    </Chip>
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
