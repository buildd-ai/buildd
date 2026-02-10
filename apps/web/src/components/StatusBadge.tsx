const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  running: 'Running',
  starting: 'Starting',
  waiting_input: 'Needs Input',
  awaiting_plan_approval: 'Awaiting Plan',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  assigned: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  starting: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  waiting_input: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  awaiting_plan_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  completed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  idle: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
    case 'starting':
      return <span className="w-1.5 h-1.5 rounded-full border border-current border-t-transparent animate-spin" />;
    case 'assigned':
      return <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />;
    case 'pending':
      return <span className="w-1.5 h-1.5 rounded-full border border-current" />;
    case 'waiting_input':
      return <span className="w-1.5 h-1.5 rotate-45 bg-current" />;
    case 'awaiting_plan_approval':
      return <span className="w-1.5 h-1.5 rounded-sm border border-current" />;
    case 'completed':
      return (
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      );
    case 'failed':
      return (
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
    default:
      return null;
  }
}

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full ${STATUS_COLORS[status] || STATUS_COLORS.pending}`}>
      <StatusIcon status={status} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

export { STATUS_COLORS, STATUS_LABELS };
