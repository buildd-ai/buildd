const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  running: 'Running',
  starting: 'Starting',
  waiting_input: 'Needs Input',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
  blocked: 'Blocked',
};

// Moodboard: status colors at 10% opacity bg, status color text, pill shape
const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  pending:                { dot: 'bg-status-warning',                        bg: 'bg-status-warning/10', text: 'text-status-warning' },
  assigned:               { dot: 'bg-status-info',                           bg: 'bg-status-info/10',    text: 'text-status-info' },
  running:                { dot: 'bg-status-running animate-status-pulse',   bg: 'bg-status-running/10', text: 'text-status-running' },
  starting:               { dot: 'bg-status-running animate-status-pulse',   bg: 'bg-status-running/10', text: 'text-status-running' },
  waiting_input:          { dot: 'bg-status-warning animate-status-pulse',   bg: 'bg-status-warning/10', text: 'text-status-warning' },
  completed:              { dot: 'bg-status-success',                        bg: 'bg-status-success/10', text: 'text-status-success' },
  failed:                 { dot: 'bg-status-error',                          bg: 'bg-status-error/10',   text: 'text-status-error' },
  idle:                   { dot: 'bg-text-muted',                            bg: 'bg-surface-3',         text: 'text-text-secondary' },
  blocked:                { dot: 'bg-status-info',                           bg: 'bg-status-info/10',    text: 'text-status-info' },
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
