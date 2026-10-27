/**
 * GET /api/health/queue and the Health › Queue tab (spec "Health › Queue"):
 * what is waiting across the team, why, and whether it will start.
 *
 * Every waiting task's reason is its one `QueueWait` (./queue-wait), read from
 * the claim route's own query, so this view, the task page, explain and the
 * terminal Queue never disagree (AC-9).
 */
import type { QueueWait } from './queue-wait';

/** The three reasons the Waiting table shows. Ready (slot) and Parked (start time) have no badge. */
export type HealthQueueReason = 'declared' | 'lane' | 'limit';
export type HealthQueueFilter = 'all' | HealthQueueReason;

/** Rows per page of the Waiting table (R-14). */
export const HEALTH_QUEUE_PAGE_SIZE = 50;

export function isHealthQueueFilter(v: unknown): v is HealthQueueFilter {
  return v === 'all' || v === 'declared' || v === 'lane' || v === 'limit';
}

export interface HealthQueueTiles {
  /** Live runs in the filtered scope. */
  running: number;
  /** Team-wide runner slots a claim can fill: never narrowed by a filter (R-2). */
  slots: number;
  ready: number;
  waiting: number;
  parked: number;
  waitingByReason: Record<HealthQueueReason, number>;
}

export interface HealthQueueWaitingRow {
  id: string;
  title: string;
  workspaceId: string;
  missionTitle: string | null;
  reason: HealthQueueReason;
  /** `Declared`, `Lane`, `Limit`. */
  badge: string;
  /** The task, `Schema lane · 2nd`, or the limit and when it lifts. */
  blockedBy: string;
  /** declared: the dependency still holding it. */
  blockerId: string | null;
  blockerStatus: string | null;
  /** declared: who set the dependency (`Its agent`, `Shared files`, a first name), and why when recorded. */
  setBy: string | null;
  why: string | null;
  /** lane: the lane it waits in, to open the lane panel. */
  lane: string | null;
  /** `3h`, `2d`. */
  age: string;
  /** Force start is offered (a Limit the Force Start contract can lift). */
  forceable: boolean;
  wait: QueueWait;
}

export interface HealthQueueReadyRow {
  id: string;
  title: string;
  /** The mission's title; null for standalone work. */
  missionTitle: string | null;
  /** When it was filed (ISO): the row's time. */
  createdAt: string;
  /** `Starts now`, `Next free slot`, or why no runner takes it. */
  note: string;
  noRunner: boolean;
}

export interface HealthQueueParkedRow {
  id: string;
  title: string;
  /** `Starts in 2h 05m`. */
  starts: string;
}

export interface HealthQueueLaneMember {
  taskId: string;
  title: string;
  /** 1 for the first waiter; null for the holder. */
  position: number | null;
  /** Holder: `Running` or `PR open`. Waiter: null. */
  state: string | null;
  /**
   * Holder: where its delivery is, for its StageMeter: building while its
   * agent runs, verifying once its PR is open. Waiter: null.
   */
  meter: { state: 'build' | 'verify' | 'queued' } | null;
  /** How long it has held the lane, or waited in it. */
  age: string | null;
  prNumber: number | null;
}

export interface HealthQueueLane {
  workspaceId: string;
  lane: string;
  /** `Schema`, or a hard surface's label. */
  name: string;
  holder: HealthQueueLaneMember | null;
  waiters: HealthQueueLaneMember[];
  /** How long the holder's PR has been quiet, when 24h or more. */
  stuckFor: string | null;
}

export interface HealthQueueResponse {
  tiles: HealthQueueTiles;
  /** One line, worst first; null when nothing is wrong (R-4). */
  alert: string | null;
  /** Idle team slots while tasks could start, for the shared IdleAlert; null when not both (R-4). */
  idle: { slots: number; tasks: number; cause: string | null } | null;
  lanes: HealthQueueLane[];
  waiting: {
    rows: HealthQueueWaitingRow[];
    filter: HealthQueueFilter;
    page: number;
    pages: number;
    /** Rows matching the filter. */
    total: number;
  };
  ready: HealthQueueReadyRow[];
  parked: HealthQueueParkedRow[];
  /** More pending tasks than one read covers: counts are a floor. */
  truncated: boolean;
  /** The reasons could not be read: no row is labelled. */
  reasonsUnavailable: boolean;
  /** Missions with pending work in the workspace scope, for the filter. */
  missions: Array<{ id: string; title: string }>;
}
