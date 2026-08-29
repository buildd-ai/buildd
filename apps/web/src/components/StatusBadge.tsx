const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  running: 'Running',
  starting: 'Starting',
  waiting_input: 'Needs Input',
  waiting_on_you: 'Waiting on you',
  // The subject-liveness claim gate excludes this task — no worker can ever
  // pick it up. See lib/subject-gate-contract.ts.
  subject_dead: 'Subject Closed',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  idle: 'Idle',
  budget_limited: 'Waiting',
  infra_failure: 'Infra Error',
  infra_stalled: 'Stalled',
};

// Moodboard: status colors at 10% opacity bg, status color text, pill shape
const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  pending:                { dot: 'bg-status-warning',                        bg: 'bg-status-warning/10', text: 'text-status-warning' },
  assigned:               { dot: 'bg-status-info',                           bg: 'bg-status-info/10',    text: 'text-status-info' },
  running:                { dot: 'bg-status-running animate-status-pulse',   bg: 'bg-status-running/10', text: 'text-status-running' },
  starting:               { dot: 'bg-status-running animate-status-pulse',   bg: 'bg-status-running/10', text: 'text-status-running' },
  waiting_input:          { dot: 'bg-status-warning animate-status-pulse',   bg: 'bg-status-warning/10', text: 'text-status-warning' },
  waiting_on_you:         { dot: 'bg-[#D97706] animate-status-pulse',        bg: 'bg-[#D97706]/10',      text: 'text-[#D97706]' },
  subject_dead:           { dot: 'bg-status-error',                          bg: 'bg-status-error/10',   text: 'text-status-error' },
  completed:              { dot: 'bg-status-success',                        bg: 'bg-status-success/10', text: 'text-status-success' },
  failed:                 { dot: 'bg-status-error',                          bg: 'bg-status-error/10',   text: 'text-status-error' },
  cancelled:              { dot: 'bg-text-muted',                            bg: 'bg-surface-3',         text: 'text-text-muted line-through' },
  idle:                   { dot: 'bg-text-muted',                            bg: 'bg-surface-3',         text: 'text-text-secondary' },
  budget_limited:         { dot: 'bg-status-warning animate-status-pulse',   bg: 'bg-status-warning/10', text: 'text-status-warning' },
  infra_failure:          { dot: 'bg-status-error',                          bg: 'bg-status-error/10',   text: 'text-status-error' },
  infra_stalled:          { dot: 'bg-[#D97706]',                             bg: 'bg-[#D97706]/10',      text: 'text-[#D97706]' },
};

const DEFAULT_STYLE = STATUS_STYLES.pending;

// Legacy export for components that reference STATUS_COLORS directly
const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_STYLES).map(([key, val]) => [key, `${val.bg} ${val.text}`])
);

export default function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || DEFAULT_STYLE;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full font-mono text-[11px] font-medium ${style.bg} ${style.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export { STATUS_COLORS, STATUS_LABELS };
