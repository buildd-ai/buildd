'use client';

interface HeartbeatStatusBadgeProps {
  lastStatus: 'ok' | 'action_taken' | 'error' | null;
  lastAt: string | null;
  isOverdue: boolean;
}

export default function HeartbeatStatusBadge({ lastStatus, lastAt, isOverdue }: HeartbeatStatusBadgeProps) {
  let dotColor: string;
  let bgColor: string;
  let label: string;
  let pulse = false;

  if (isOverdue) {
    dotColor = 'bg-status-error';
    bgColor = 'bg-status-error/10 text-status-error border border-status-error/20';
    label = 'Missed';
  } else if (lastStatus === 'ok') {
    dotColor = 'bg-status-success';
    bgColor = 'bg-status-success/10 text-status-success border border-status-success/20';
    label = 'OK';
    pulse = true;
  } else if (lastStatus === 'action_taken') {
    dotColor = 'bg-status-warning';
    bgColor = 'bg-status-warning/10 text-status-warning border border-status-warning/20';
    label = 'Action Taken';
  } else if (lastStatus === 'error') {
    dotColor = 'bg-status-error';
    bgColor = 'bg-status-error/10 text-status-error border border-status-error/20';
    label = 'Error';
  } else {
    dotColor = 'bg-text-muted';
    bgColor = 'bg-surface-3 text-text-muted border border-border-default';
    label = 'Pending';
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${bgColor}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} ${pulse ? 'animate-pulse' : ''}`} />
      {label}
      {lastAt && (
        <span className="opacity-60 ml-0.5">
          {timeAgoShort(lastAt)}
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
