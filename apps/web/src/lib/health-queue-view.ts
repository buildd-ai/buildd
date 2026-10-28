// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Health › Queue's view (spec "Health › Queue", R-3 to R-9): tiles, the alert
 * line, lanes, the Waiting table, Ready and Parked, from rows already read in
 * claim order with each task's one wait (lib/health-queue.ts).
 *
 * Pure and client-safe: the clock is an argument. The reason words are
 * @buildd/shared queue-wait's, the same every other surface uses (AC-9).
 */
import {
  HEALTH_QUEUE_PAGE_SIZE,
  laneLabel,
  queueWaitBadge,
  queueWaitBlockedBy,
  queueWhen,
  type HealthQueueFilter,
  type HealthQueueLane,
  type HealthQueueLaneMember,
  type HealthQueueReason,
  type HealthQueueResponse,
  type HealthQueueWaitingRow,
  type QueueWait,
} from '@buildd/shared';

/** One pending task, in claim order, with its one wait (null: not read). */
export interface HealthQueueTaskInput {
  id: string;
  title: string;
  workspaceId: string;
  missionTitle: string | null;
  createdAt: string;
  wait: QueueWait | null;
  /** declared: who set the dependency and why, when known. */
  setBy?: string | null;
  why?: string | null;
}

/** One lane row as loadLanes gives it, in lane order, with its task's title. */
export interface HealthQueueLaneMemberInput {
  taskId: string;
  title: string;
  holding: boolean;
  status: string;
  prNumber: number | null;
  /** Holder: when it took the lane. Waiter: when it became claimable. */
  since: string | null;
  /** Holder: when its PR went quiet, if 24h or more ago. */
  stuckSince: string | null;
}

export interface HealthQueueViewInput {
  now: number;
  /** Live runs in the filtered scope. */
  running: number;
  /** Team-wide schedulable runner slots. */
  slots: number;
  /** The Capacity block's pair (R-3, AC-14); defaults to running of slots. */
  capacity?: { used: number; total: number };
  /** Team-wide live runs, for idle slots. */
  teamBusy: number;
  /** Measured: when each live run is expected to end (epoch ms), from its frozen estimate. Absent or short: no estimate. */
  runEnds?: number[];
  tasks: HealthQueueTaskInput[];
  lanes: Array<{ workspaceId: string; lane: string; members: HealthQueueLaneMemberInput[] }>;
  filter: HealthQueueFilter;
  page: number;
  truncated: boolean;
  reasonsUnavailable?: boolean;
  missions: Array<{ id: string; title: string }>;
}

/** `12m`, `5h`, `3d`. */
export function queueAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const since = (at: string | null, now: number): string | null => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? queueAge(now - t) : null;
};

const REASON_ORDER: Record<HealthQueueReason, number> = { lane: 0, limit: 1, declared: 2 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The holder's state in the terms catalog's words: an agent on it is Running. */
function holderState(m: HealthQueueLaneMemberInput): string {
  return m.prNumber != null ? 'PR open' : 'Running';
}

/** The holder's StageMeter reading: an open PR is verifying, a live agent building, else not started. */
function holderMeter(m: HealthQueueLaneMemberInput): NonNullable<HealthQueueLaneMember['meter']> {
  if (m.prNumber != null) return { state: 'verify' };
  return { state: m.status === 'in_progress' || m.status === 'assigned' ? 'build' : 'queued' };
}

function laneView(l: HealthQueueViewInput['lanes'][number], now: number): HealthQueueLane | null {
  if (l.members.length === 0) return null;
  const holderIn = l.members.find(m => m.holding) ?? null;
  const holder: HealthQueueLaneMember | null = holderIn
    ? { taskId: holderIn.taskId, title: holderIn.title, position: null, state: holderState(holderIn), meter: holderMeter(holderIn), age: since(holderIn.since, now), prNumber: holderIn.prNumber }
    : null;
  const waiters = l.members.filter(m => !m.holding).map((m, i): HealthQueueLaneMember => ({
    taskId: m.taskId, title: m.title, position: i + 1, state: null, meter: null, age: since(m.since, now), prNumber: m.prNumber,
  }));
  return {
    workspaceId: l.workspaceId,
    lane: l.lane,
    name: laneLabel(l.lane),
    holder,
    waiters,
    stuckFor: holderIn ? since(holderIn.stuckSince, now) : null,
  };
}

export function buildHealthQueueView(input: HealthQueueViewInput): HealthQueueResponse {
  const { now } = input;
  const ready: HealthQueueTaskInput[] = [];
  const parked: HealthQueueTaskInput[] = [];
  const waiting: HealthQueueWaitingRow[] = [];
  const byReason: Record<HealthQueueReason, number> = { declared: 0, lane: 0, limit: 0 };

  for (const t of input.tasks) {
    const w = t.wait;
    if (!w) continue;
    if (w.kind === 'slot') { ready.push(t); continue; }
    if (w.kind === 'start_time') { parked.push(t); continue; }
    const reason = w.kind as HealthQueueReason;
    byReason[reason] += 1;
    const created = Date.parse(t.createdAt);
    waiting.push({
      id: t.id,
      title: t.title,
      workspaceId: t.workspaceId,
      missionTitle: t.missionTitle,
      reason,
      badge: queueWaitBadge(w) ?? '',
      blockedBy: queueWaitBlockedBy(w, now) ?? '',
      blockerId: reason === 'declared' ? w.blockerId ?? null : null,
      blockerStatus: reason === 'declared' ? w.blockerStatus ?? null : null,
      setBy: reason === 'declared' ? t.setBy ?? null : null,
      why: reason === 'declared' ? t.why ?? null : null,
      lane: reason === 'lane' ? w.lane ?? 'migration' : null,
      age: Number.isFinite(created) ? queueAge(now - created) : '',
      forceable: reason === 'limit' && w.forceable === true,
      wait: w,
    });
  }

  const createdAt = new Map(input.tasks.map(t => [t.id, Date.parse(t.createdAt) || 0]));
  waiting.sort((a, b) => {
    const byKind = REASON_ORDER[a.reason] - REASON_ORDER[b.reason];
    if (byKind) return byKind;
    if (a.reason === 'lane') {
      const pa = a.wait.position ?? Number.MAX_SAFE_INTEGER;
      const pb = b.wait.position ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
    }
    return (createdAt.get(a.id) ?? 0) - (createdAt.get(b.id) ?? 0);
  });

  const filtered = input.filter === 'all' ? waiting : waiting.filter(r => r.reason === input.filter);
  const pages = Math.max(1, Math.ceil(filtered.length / HEALTH_QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(input.page) || 1), pages);
  const rows = filtered.slice((page - 1) * HEALTH_QUEUE_PAGE_SIZE, page * HEALTH_QUEUE_PAGE_SIZE);

  const idle = Math.max(0, input.slots - input.teamBusy);
  let startsNow = idle;
  const runEnds = [...(input.runEnds ?? [])].sort((a, b) => a - b);
  let freeIdx = 0;
  // Claim order, as read (R-7, R-15): the first free slots go to the first rows.
  const readyRows = ready.slice(0, HEALTH_QUEUE_PAGE_SIZE).map(t => {
    const row = { id: t.id, title: t.title, missionTitle: t.missionTitle, createdAt: t.createdAt };
    const noRunner = t.wait?.noRunnerReason ?? null;
    if (noRunner) return { ...row, note: `No runner: ${noRunner}`, noRunner: true };
    if (startsNow > 0) { startsNow -= 1; return { ...row, note: 'Starts now', noRunner: false }; }
    // The k-th row past the idle slots takes the k-th earliest end; no measured end, no time.
    const end = runEnds[freeIdx++];
    const note = end != null ? `Next free slot ~${queueAge(Math.max(0, end - now))}` : 'Next free slot';
    return { ...row, note, noRunner: false };
  });

  const lanes = input.lanes.map(l => laneView(l, now)).filter((l): l is HealthQueueLane => !!l);

  // R-4: worst first. Idle slots while work could start, then stuck lanes.
  const alerts: string[] = [];
  let idleAlert: HealthQueueResponse['idle'] = null;
  if (idle > 0 && ready.length > 0) {
    const causes = [...new Set(ready.map(t => t.wait?.noRunnerReason).filter((c): c is string => !!c))].slice(0, 2);
    idleAlert = { slots: idle, tasks: ready.length, cause: causes.length ? causes.join(', ') : null };
    alerts.push(`${plural(idle, 'idle slot', 'idle slots')}, ${plural(ready.length, 'task could start', 'tasks could start')}${causes.length ? ` · ${causes.join(', ')}` : ''}`);
  }
  for (const l of lanes) if (l.stuckFor) alerts.push(`${l.name} lane stuck ${l.stuckFor}`);

  return {
    tiles: {
      running: input.running,
      slots: input.slots,
      capacity: input.capacity ?? { used: input.running, total: input.slots },
      ready: ready.length,
      waiting: waiting.length,
      parked: parked.length,
      waitingByReason: byReason,
    },
    alert: alerts.length > 0 ? alerts.join(' · ') : null,
    idle: idleAlert,
    lanes,
    waiting: { rows, filter: input.filter, page, pages, total: filtered.length },
    ready: readyRows,
    parked: parked.slice(0, HEALTH_QUEUE_PAGE_SIZE).map(t => ({
      id: t.id,
      title: t.title,
      starts: t.wait?.startAt ? `Starts ${queueWhen(t.wait.startAt, now)}` : 'Scheduled',
    })),
    truncated: input.truncated,
    reasonsUnavailable: !!input.reasonsUnavailable,
    missions: input.missions,
  };
}
