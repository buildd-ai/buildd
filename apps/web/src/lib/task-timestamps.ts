/**
 * Backward-compat barrel — re-exports from the canonical module.
 * Import from '@/lib/task-presentation' in new code.
 */
export {
  STALENESS_THRESHOLD_MS,
  LIVE_WORKER_STATUSES,
  deriveDisplayStatus,
  isStaleWorker,
  deriveTimestampLabel,
} from './task-presentation';
export type { TimestampLabelParams } from './task-presentation';
