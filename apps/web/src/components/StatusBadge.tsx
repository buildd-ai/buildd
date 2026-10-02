import Chip, { type ChipTone } from '@/components/ui/Chip';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  running: 'Running',
  // A task row claimed and being worked (`tasks.status`); same word the task header uses.
  in_progress: 'Running',
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
  never_started: 'Never Started',
  silent_start: 'No Output',
};

/**
 * Status → Chip tone. `waiting_on_you` is `accent` (orange means "this is
 * yours to act on"); it and `infra_stalled` used a raw hex before the Chip
 * (docs/design/design-system.md §4).
 */
const STATUS_TONES: Record<string, { tone: ChipTone; pulse?: boolean }> = {
  pending:        { tone: 'warning' },
  assigned:       { tone: 'info' },
  running:        { tone: 'running', pulse: true },
  starting:       { tone: 'running', pulse: true },
  in_progress:    { tone: 'running', pulse: true },
  waiting_input:  { tone: 'warning', pulse: true },
  waiting_on_you: { tone: 'accent', pulse: true },
  subject_dead:   { tone: 'error' },
  completed:      { tone: 'success' },
  failed:         { tone: 'error' },
  cancelled:      { tone: 'muted' },
  idle:           { tone: 'muted' },
  budget_limited: { tone: 'warning', pulse: true },
  infra_failure:  { tone: 'error' },
  infra_stalled:  { tone: 'warning' },
  // Not real task failures: a row no runner started, and a session that streamed
  // nothing. Muted so they don't read as agent errors in the timeline.
  never_started:  { tone: 'muted' },
  silent_start:   { tone: 'warning' },
};

const DEFAULT_TONE = STATUS_TONES.pending;

// Legacy export: a bg + text class pair per status, for inline spans that do
// not render the badge itself. Full strings so Tailwind sees them.
const TONE_COLORS: Record<ChipTone, string> = {
  success: 'bg-status-success/10 text-status-success',
  running: 'bg-status-running/10 text-status-running',
  warning: 'bg-status-warning/10 text-status-warning',
  error: 'bg-status-error/10 text-status-error',
  info: 'bg-status-info/10 text-status-info',
  accent: 'bg-accent-soft text-accent-text',
  muted: 'bg-surface-3 text-text-muted',
};
const STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_TONES).map(([key, { tone }]) => [key, TONE_COLORS[tone]]),
);

export default function StatusBadge({ status }: { status: string }) {
  const { tone, pulse } = STATUS_TONES[status] || DEFAULT_TONE;
  return (
    <Chip tone={tone} variant="soft" pulse={pulse} className={status === 'cancelled' ? 'line-through' : ''}>
      {STATUS_LABELS[status] || status}
    </Chip>
  );
}

export { STATUS_COLORS, STATUS_LABELS, STATUS_TONES };
