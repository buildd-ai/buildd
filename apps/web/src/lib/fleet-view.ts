// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Home's fleet panel model: runners × slots, each slot's live worker and its
 * day on a lane timeline. Pure and client-safe — `lib/home-fleet.ts` loads the
 * rows, this shapes them.
 *
 * Slots are not stored anywhere: a runner reports only `maxConcurrentWorkers`
 * and each worker only which runner it ran on. Slots are derived from overlap
 * with `SlotLanes`' own `assignSlots` (components/fleet/slot-lanes-layout.ts),
 * so the slot a row describes here is the slot the lanes chart draws.
 */
import { beatWithin, runnerOnlineNow, INTERACTIVE_WORKER_RUNNER, RUNNER_LIVE_WINDOW_MS, questionSessionEnded, activeRunnerHold, runnerUpdateState, executorDisplayName, isRecordedModelRoute, type RecordedModelRoute, fleetGroupKey, isEphemeralRunner, isOnceRunnerUrl, runnerFleetIdentity, type FleetRunner, type FleetSlot, type FleetSlotCounts, type FleetSnapshot, type LaneBar, type RunnerFleetIdentity } from '@buildd/shared';
import { assignSlots, fitLaneWindowStart } from '@/components/fleet/slot-lanes-layout';
import { runnerIdentity, runnerNameFromUrl } from './runner-display';
import { missionTaskHref } from './mission-task-href';
import { taskShortLabel } from './segment-label';
import { taskDisplayLabel } from '@buildd/core/task-label';
import { taskShortName } from './task-title';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { runEndReason } from './fleet-view-end-reason';
import { accountablePrincipal } from './fleet-occupancy';

type DateLike = Date | string | null | undefined;

export interface FleetHeartbeatRow {
  id: string;
  accountId: string;
  localUiUrl: string;
  maxConcurrentWorkers: number;
  /** `fleet`: a `--once` run's identity (@buildd/shared runner-fleet). */
  environment?: { labels?: Record<string, string> | null; fleet?: unknown; hold?: unknown } | null;
  lastHeartbeatAt: DateLike;
  /** Pusher presence; null/absent = never joined, judged by the beat alone (runnerOnlineNow). */
  presenceConnected?: boolean | null;
  /** What the runner last reported running. Decides an ephemeral run's share of capacity. */
  activeWorkerCount?: number | null;
  /** The self-update it reported applying (@buildd/shared runner-update), when one. */
  updateDrain?: unknown;
}

interface FleetGroup {
  hb: FleetHeartbeatRow | null;
  key: string;
  workers: FleetWorkerRow[];
  /** Set for a group of ephemeral `--once` runs (one cloud dispatcher). */
  elastic: { identity: RunnerFleetIdentity; heartbeats: FleetHeartbeatRow[] } | null;
}

export interface FleetWorkerRow {
  id: string;
  accountId?: string | null;
  /** The user who claimed the run (`workers.claimedByUserId`); null when unknown. */
  ownerId?: string | null;
  /** `tasks.createdByUserId`: decides `mine` on runner work (null: service-owned). Absent: the claimer decides. */
  taskOwnerId?: string | null;
  runner: string;
  localUiUrl?: string | null;
  status: string;
  startedAt?: DateLike;
  completedAt?: DateLike;
  updatedAt?: DateLike;
  prNumber?: number | null;
  waitingFor?: { prompt?: string; type?: string | null; since?: string | null } | null;
  /** The worker's error text, only ever read for its class (lib/fleet-view-end-reason.ts), never shown. */
  error?: string | null;
  /** This run's own PR merged. */
  mergedAt?: DateLike;
  /** The model route the claim recorded for this run (`workers.modelRoute`). */
  modelRoute?: string | null;
  /** A merged PR of the same task, from this run or a later one. */
  taskMergedPr?: number | null;
  /** Latest phase supported by lifecycle evidence. */
  phase?: string | null;
  task?: {
    id: string;
    title: string;
    label?: string | null;
    mode?: string | null;
    roleSlug?: string | null;
    missionId?: string | null;
    taskClass?: string | null;
    /** A helper run (check, audit, final verification), from `helperRunSql`. */
    helper?: boolean | null;
    /** The task a helper checks, when it checks one. */
    hostTaskId?: string | null;
  } | null;
}

export interface BuildFleetOptions {
  now?: number;
  /** Role slug → name + colour, from the roles themselves. */
  roles?: ReadonlyMap<string, { name: string; color: string | null }>;
  /** A heartbeat older than this reads offline. */
  onlineThresholdMs?: number;
  /** Earliest the timeline reaches back. */
  maxWindowMs?: number;
  /** Interactive sessions online now (lib/local-session-view.ts), for the sessions lane's caption. */
  sessionsOnline?: number | null;
  /** The person looking: slot runs get `mine` against their claiming user. */
  viewerId?: string | null;
}

/** The sessions lane's name on the board. */
export const SESSIONS_LANE_NAME = 'Your sessions';

/**
 * How fresh a runner's last beat must be for the fleet to count it online.
 * Presence, not "not dead": the 60s liveness ping keeps a running runner well
 * inside this, and a restarted runner's abandoned row drops out within a few
 * minutes instead of being counted (with its slots) for 1.5 poll intervals.
 */
export const FLEET_ONLINE_WINDOW_MS = RUNNER_LIVE_WINDOW_MS;

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const ms = (d: DateLike) => (d == null ? NaN : new Date(d).getTime());

/**
 * A run still going: live, and not a question whose session ended. That one
 * is a wait for a person (Needs you), not a running agent: its bar ends where
 * the session did (its last write), and it holds no slot and no live count
 * (`questionSessionEnded`, the rule the claim cap counts by).
 */
const runsNow = (w: Pick<FleetWorkerRow, 'status' | 'error'>) => LIVE.has(w.status) && !questionSessionEnded(w);

// Runner naming is shared with the Board, Lanes and task page.
export { runnerIdentity, runnerNameFromUrl } from './runner-display';

function barState(status: string): LaneBar['state'] {
  if (status === 'waiting_input') return 'waiting';
  if (LIVE.has(status)) return 'running';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'done';
}

/** Online by presence when the runner has joined it, else by the beat inside `windowMs`. */
function beatUp(hb: { lastHeartbeatAt: DateLike; presenceConnected?: boolean | null }, now: number, windowMs: number): boolean {
  return hb.presenceConnected == null
    ? beatWithin(ms(hb.lastHeartbeatAt), now, windowMs + 1)
    : runnerOnlineNow(ms(hb.lastHeartbeatAt), hb.presenceConnected, now);
}

type CapacityBeat = Pick<FleetHeartbeatRow, 'maxConcurrentWorkers' | 'lastHeartbeatAt'> & Partial<Pick<FleetHeartbeatRow, 'presenceConnected' | 'localUiUrl' | 'environment' | 'activeWorkerCount' | 'updateDrain'>>;

/** The slots one runner advertises. */
function advertisedSlots(hb: CapacityBeat): number {
  // An ephemeral `--once` run is one slot while it runs and none after: it
  // never takes a second task, and its container is gone once it is done.
  // Rows written before the server stored 1 for these still say the
  // account default, so the stored number is not trusted here.
  if (hb.localUiUrl && isEphemeralRunner({ localUiUrl: hb.localUiUrl, environment: hb.environment })) {
    return (hb.activeWorkerCount ?? 0) > 0 ? 1 : 0;
  }
  return hb.maxConcurrentWorkers ?? 0;
}

/**
 * Runner slots now, by state (`FleetSlotCounts` without `busy`): configured
 * on every runner given (the caller's not-dead rows), online on the ones
 * whose beat is fresh, schedulable on the online ones not on hold (the claim
 * route returns nothing to a held runner).
 */
export function fleetSlotCounts(
  heartbeats: readonly CapacityBeat[],
  opts: { now?: number; onlineThresholdMs?: number } = {},
): Omit<FleetSlotCounts, 'busy'> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.onlineThresholdMs ?? 90_000;
  let configured = 0, online = 0, schedulable = 0;
  for (const hb of heartbeats) {
    const n = advertisedSlots(hb);
    configured += n;
    if (!beatUp(hb, now, windowMs)) continue;
    online += n;
    // Held, or updating (it claims nothing until it continues its paused agents): no free slots.
    if (!activeRunnerHold(hb.environment, now) && !runnerUpdateState({ updateDrain: hb.updateDrain, lastHeartbeatAt: hb.lastHeartbeatAt }, now)) schedulable += n;
  }
  return { configured, online, schedulable, asOf: now, windowMs };
}

/**
 * THE fleet capacity: `maxConcurrentWorkers` summed over the runners whose
 * heartbeat is fresh. Home's "AGENTS LIVE n/N" and the mission Lanes band's
 * "LIVE n/N slots" both read this, so the two denominators cannot disagree.
 */
export function fleetCapacity(
  heartbeats: readonly CapacityBeat[],
  opts: { now?: number; onlineThresholdMs?: number } = {},
): number {
  return fleetSlotCounts(heartbeats, opts).online;
}

export function buildFleetSnapshot(
  heartbeats: readonly FleetHeartbeatRow[],
  workerRows: readonly FleetWorkerRow[],
  opts: BuildFleetOptions = {},
): FleetSnapshot {
  const now = opts.now ?? Date.now();
  const onlineMs = opts.onlineThresholdMs ?? 90_000;
  const roles = opts.roles ?? new Map();

  // Worker → runner: the runner claims with `runner = <its localUiUrl>` and
  // reports the same URL on the worker; heartbeats are unique per (account, URL).
  const hbByUrl = new Map<string, FleetHeartbeatRow[]>();
  for (const hb of heartbeats) hbByUrl.set(hb.localUiUrl, [...(hbByUrl.get(hb.localUiUrl) ?? []), hb]);
  // An ephemeral `--once` run (one container per cloud task) is not a machine:
  // every run of one dispatcher folds into one elastic group (fleetGroupKey).
  const groups = new Map<string, FleetGroup>();
  const groupOf = (hb: FleetHeartbeatRow): string => {
    const elasticKey = fleetGroupKey(hb);
    if (!elasticKey) {
      groups.set(hb.id, groups.get(hb.id) ?? { hb, key: hb.localUiUrl, workers: [], elastic: null });
      return hb.id;
    }
    const g = groups.get(elasticKey) ?? { hb: null, key: hb.localUiUrl, workers: [], elastic: { identity: runnerFleetIdentity(hb), heartbeats: [] } };
    g.elastic!.heartbeats.push(hb);
    groups.set(elasticKey, g);
    return elasticKey;
  };
  const gidByHb = new Map<string, string>();
  for (const hb of heartbeats) gidByHb.set(hb.id, groupOf(hb));
  // A claim from a person's own coding session (claim_task over MCP) is not on
  // any runner: no heartbeat, no slot of runner capacity. Its live ones get
  // the sessions lane below; finished ones are not drawn (like a finished
  // elastic run, there is no slot left to show them in).
  const sessionWorkers: FleetWorkerRow[] = [];
  for (const w of workerRows) {
    if (w.runner === INTERACTIVE_WORKER_RUNNER && !w.localUiUrl) {
      if (LIVE.has(w.status)) sessionWorkers.push(w);
      continue;
    }
    const key = w.localUiUrl || w.runner;
    const candidates = hbByUrl.get(key) ?? [];
    const hb = candidates.find(h => !w.accountId || h.accountId === w.accountId) ?? null;
    // A run whose heartbeat already aged out still belongs to its group.
    const orphanElastic = !hb && isOnceRunnerUrl(key) ? fleetGroupKey({ accountId: w.accountId ?? null, localUiUrl: key }) : null;
    const gid = hb ? gidByHb.get(hb.id)! : orphanElastic ?? `runner:${key}`;
    if (!groups.has(gid)) {
      groups.set(gid, {
        hb: null, key, workers: [],
        elastic: orphanElastic ? { identity: runnerFleetIdentity({ localUiUrl: key }), heartbeats: [] } : null,
      });
    }
    groups.get(gid)!.workers.push(w);
  }

  const runners: FleetRunner[] = [];
  let live = 0;
  const slotCounts = fleetSlotCounts(heartbeats, { now, onlineThresholdMs: onlineMs });
  const capacity = slotCounts.online;

  /** One run onto its slot: the lane bar, and the live worker or the slot's last run. */
  const place = (slot: FleetSlot, w: FleetWorkerRow, iv: { start: number; end: number | null }, isSession = false) => {
    const t = w.task ?? null;
    const principal = accountablePrincipal(isSession ? 'interactive' : 'runner', w.ownerId, w.taskOwnerId);
    const mine = opts.viewerId ? (principal ? principal === opts.viewerId : null) : undefined;
    const { label, rest } = t ? taskShortLabel(t) : { label: 'task', rest: '' };
    // The task's own short label ("reconcile exports spec") names the run;
    // the one-word pick is only a chip beside it. "untitled" names nothing.
    const shown = t ? taskDisplayLabel({ title: t.title ?? '', label: t.label ?? null }).label : null;
    const taskLabel = shown && shown !== 'untitled' ? shown : null;
    const role = t?.roleSlug ? roles.get(t.roleSlug) : undefined;
    slot.lane.bars.push({
      id: w.id, start: iv.start, end: iv.end, label: taskLabel ?? label,
      scope: taskLabel && label !== taskLabel.split(/\s+/)[0]?.toLowerCase() ? label : null,
      title: t?.title ?? null,
      color: role?.color ?? null, roleSlug: t?.roleSlug ?? null, roleName: role?.name ?? null,
      prNumber: w.prNumber ?? null, state: barState(w.status), missionId: t?.missionId ?? null,
      taskId: t?.id ?? null,
      endReason: runEndReason({
        status: w.status, error: w.error ?? null, prNumber: w.prNumber ?? null,
        mergedAt: w.mergedAt ? new Date(w.mergedAt) : null, taskMergedPr: w.taskMergedPr ?? null, waitingFor: w.waitingFor ?? null,
        now,
      }),
      href: t ? missionTaskHref({ missionId: t.missionId ?? null, taskId: t.id, from: 'home' }) : null,
    });
    if (runsNow(w)) {
      live++;
      slot.worker = {
        workerId: w.id, taskId: t?.id ?? null, missionId: t?.missionId ?? null,
        label, rest, name: t ? taskShortName(t) : undefined, title: t?.title ?? null, roleSlug: t?.roleSlug ?? null, roleName: role?.name ?? null, roleColor: role?.color ?? null,
        status: w.status, phase: w.phase ?? null,
        ...(t?.helper ? { helper: true } : {}),
        ...(t?.helper && t.hostTaskId ? { hostTaskId: t.hostTaskId } : {}),
        startedAt: new Date(iv.start).toISOString(),
        question: w.status === 'waiting_input' ? w.waitingFor?.prompt ?? 'Has a question' : null,
        ...(mine !== undefined && { mine }),
      };
    } else {
      slot.last = {
        label: taskLabel, scope: label || null, prNumber: w.prNumber ?? null, fix: t?.taskClass === 'attempt',
        failed: barState(w.status) === 'failed', at: iv.end,
        ...(mine !== undefined && { mine }),
      };
    }
  };

  for (const [gid, g] of groups) {
    if (g.elastic) {
      // Only what is running now: a finished run's container is gone, so it
      // is neither a slot nor a runner (its heartbeat may still be fresh).
      const running = g.workers
        .filter(runsNow)
        .map(w => ({ w, start: Number.isFinite(ms(w.startedAt)) ? ms(w.startedAt) : now }))
        .sort((a, b) => a.start - b.start || a.w.id.localeCompare(b.w.id));
      if (running.length === 0) continue;
      const slots: FleetSlot[] = running.map((_, index) => ({ index, worker: null, last: null, lane: { id: `${gid}:${index}`, bars: [] } }));
      running.forEach(({ w, start }, i) => place(slots[i], w, { start, end: null }));
      const { identity, heartbeats: hbs } = g.elastic;
      const first = hbs[0] ?? null;
      const name = identity.group ?? (first ? runnerIdentity(first).name : runnerNameFromUrl(g.key));
      const machine = [executorDisplayName(identity.executor), 'elastic'].filter(Boolean).join(' · ');
      runners.push({
        id: gid, name, machine, maxSlots: slots.length,
        // A live run is the proof the group is up; a fresh beat from any run confirms it.
        online: hbs.length === 0 ? false : hbs.some(hb => beatUp(hb, now, onlineMs)),
        slots,
        elastic: { executor: identity.executor, group: identity.group, running: running.length },
      });
      continue;
    }
    const liveHere = g.workers.filter(runsNow);
    // A runner we have no heartbeat for is shown only while it holds live work.
    if (!g.hb && liveHere.length === 0) continue;
    const online = !!g.hb && beatUp(g.hb, now, onlineMs);
    const identity = g.hb ? runnerIdentity(g.hb) : { name: runnerNameFromUrl(g.key), machine: null };
    const intervals = g.workers
      .filter(w => Number.isFinite(ms(w.startedAt)))
      .map(w => ({
        id: w.id,
        start: ms(w.startedAt),
        end: runsNow(w) ? null : (Number.isFinite(ms(w.completedAt)) ? ms(w.completedAt) : ms(w.updatedAt)) || ms(w.startedAt),
      }));
    const assigned = assignSlots(intervals);
    // Lanes need a row per run that overlapped; the runner's size is what it
    // advertises. Mixing the two read "6 of 7 busy" on one page and "6/6" on
    // another for the same 5-slot runner.
    const cap = Math.max(g.hb?.maxConcurrentWorkers ?? 0, assigned.slots, 1);
    // A runner set to 0 advertises 0 (spec 97b1bd0b R-18): "0/0", never a slot it does not have.
    const advertised = g.hb ? Math.max(g.hb.maxConcurrentWorkers ?? 0, 0) : Math.max(liveHere.length, 1);
    const laneOf = assigned.slotOf;
    const slots: FleetSlot[] = Array.from({ length: cap }, (_, index) => ({
      index, worker: null, last: null, lane: { id: `${gid}:${index}`, bars: [] },
    }));

    const byId = new Map(g.workers.map(w => [w.id, w]));
    for (const iv of [...intervals].sort((a, b) => a.start - b.start)) {
      place(slots[laneOf.get(iv.id) ?? 0], byId.get(iv.id)!, iv);
    }
    // A person's hold (`buildd hold`): shown as on hold, not idle, while in force.
    const hold = g.hb ? activeRunnerHold(g.hb.environment, now) : null;
    const routeCounts = new Map<RecordedModelRoute, number>();
    for (const w of g.workers) if (isRecordedModelRoute(w.modelRoute)) routeCounts.set(w.modelRoute, (routeCounts.get(w.modelRoute) ?? 0) + 1);
    const routes = [...routeCounts].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));
    // A self-update in progress (spec 47c97f48 R-5..R-7): updating, or stuck.
    const update = g.hb ? runnerUpdateState({ updateDrain: g.hb.updateDrain, lastHeartbeatAt: g.hb.lastHeartbeatAt }, now) : null;
    runners.push({ id: gid, name: identity.name, machine: identity.machine, maxSlots: advertised, online, slots, ...(routes.length ? { routes } : {}), ...(hold ? { hold } : {}), ...(update ? { update } : {}) });
  }

  runners.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  // One row per live session claim, oldest first. A claim whose start time was
  // never stamped starts at its last activity (it is still a working row, not
  // an empty slot).
  let sessions: FleetRunner | null = null;
  if (sessionWorkers.length > 0) {
    const liveBefore = live;
    const running = sessionWorkers
      .map(w => ({ w, start: [ms(w.startedAt), ms(w.updatedAt)].find(Number.isFinite) ?? now }))
      .sort((a, b) => a.start - b.start || a.w.id.localeCompare(b.w.id));
    const slots: FleetSlot[] = running.map((_, index) => ({ index, worker: null, last: null, lane: { id: `sessions:${index}`, bars: [] } }));
    running.forEach(({ w, start }, i) => place(slots[i], w, { start, end: null }, true));
    live = liveBefore; // session claims are not runner slots
    sessions = {
      id: 'sessions', name: SESSIONS_LANE_NAME, machine: null, maxSlots: slots.length, online: true, slots,
      interactive: { running: running.length, online: opts.sessionsOnline ?? null },
    };
  }
  // The window frames the current burst: from just before the earliest run
  // still live or ended in the last hour (so an idle-since-lunch fleet does
  // not stretch the axis to breakfast), at least `LANE_WINDOW_MIN_SPAN_MS`,
  // at most `maxWindowMs`. Older bars fall outside and SlotLanes drops them.
  const maxWindow = opts.maxWindowMs ?? 8 * 3_600_000;
  const recentCut = now - 60 * 60_000;
  let earliest: number | null = null;
  for (const r of sessions ? [...runners, sessions] : runners) for (const sl of r.slots) for (const b of sl.lane.bars) {
    if (b.end == null || b.end >= recentCut) earliest = earliest == null ? b.start : Math.min(earliest, b.start);
  }
  const from = fitLaneWindowStart({ earliest, now, maxSpanMs: maxWindow });
  const busy = runners.reduce((n, r) => n + (r.online ? r.slots.filter(sl => sl.worker).length : 0), 0);
  return { runners, sessions, live, capacity, slots: { ...slotCounts, busy }, window: { from, to: now } };
}

/** One row of a runner's slot table: a slot, or every quiet slot folded into a count. */
export type FleetDisplayRow =
  | { kind: 'slot'; slot: FleetSlot }
  | { kind: 'idle'; count: number; slots: FleetSlot[] };

/**
 * Which of a runner's slots get their own row. Ten rows of "idle" bury the one
 * slot doing something, so: every busy slot, plus up to `recentIdle` idle slots
 * whose last run ended inside the chart window (the most recent ones), each in
 * its own row IN SLOT ORDER, then everything else folded into one "N idle
 * slots" row. A single leftover slot keeps its row — folding one row into one
 * row hides a name for nothing.
 *
 * Slot order, not busy-first: a running task keeps its row for its whole run.
 * Sorting busy slots to the top moved a task up a row the moment the slot above
 * it finished, which on a live dashboard reads as the work hopping runners.
 */
export function fleetDisplayRows(runner: FleetRunner, opts: { since?: number; recentIdle?: number } = {}): FleetDisplayRow[] {
  const recentIdle = opts.recentIdle ?? 2;
  const since = opts.since ?? -Infinity;
  const busy = runner.slots.filter(s => s.worker);
  const idle = runner.slots.filter(s => !s.worker);
  const recent = idle
    .filter(s => s.last?.at != null && s.last.at >= since)
    .sort((a, b) => (b.last!.at ?? 0) - (a.last!.at ?? 0))
    .slice(0, recentIdle);
  const rest = idle.filter(s => !recent.includes(s));
  const shown = [...busy, ...recent].sort((a, b) => a.index - b.index);
  const rows: FleetDisplayRow[] = shown.map(slot => ({ kind: 'slot', slot }));
  if (rest.length === 1) rows.push({ kind: 'slot', slot: rest[0] });
  else if (rest.length > 1) rows.push({ kind: 'idle', count: rest.length, slots: rest });
  return rows;
}

export { runnerBusyLine } from './runner-busy-line';

export interface FleetSummary {
  busy: number;
  slots: number;
  online: number;
  runnerNames: string[];
  /** The most recent finished run anywhere in the fleet. */
  last: { label: string; at: number; failed: boolean } | null;
}

/** The one-line fleet summary: slots busy, runners, and the last thing that finished. */
export function fleetSummary(fleet: FleetSnapshot): FleetSummary {
  let last: FleetSummary['last'] = null;
  for (const r of fleet.runners) for (const sl of r.slots) for (const b of sl.lane.bars) {
    if (b.end == null || b.state === 'running' || b.state === 'waiting') continue;
    if (!last || b.end > last.at) last = { label: b.label, at: b.end, failed: b.state === 'failed' };
  }
  return {
    busy: fleet.runners.reduce((n, r) => n + r.slots.filter(s => s.worker).length, 0),
    slots: fleet.runners.reduce((n, r) => n + r.maxSlots, 0),
    online: fleet.runners.filter(r => r.online).length,
    runnerNames: fleet.runners.map(r => r.name),
    last,
  };
}

/**
 * The runners section label: "Runners · 2 runners × 4 slots", or without the
 * "× N slots" when runners differ in size. Home's panel and Settings → Runners
 * both print it, so the two pages name the fleet the same way.
 */
export function fleetLabel(fleet: Pick<FleetSnapshot, 'runners'>): string {
  // An elastic group has no fixed size; it is counted apart from the machines.
  const hosts = fleet.runners.filter(r => !r.elastic);
  const groups = fleet.runners.length - hosts.length;
  const n = hosts.length;
  const sizes = new Set(hosts.map(r => r.maxSlots));
  const each = sizes.size === 1 && n > 0 ? ` × ${[...sizes][0]} slots` : '';
  const elastic = groups > 0 ? `${groups} elastic group${groups === 1 ? '' : 's'}` : '';
  if (n === 0 && elastic) return `Runners · ${elastic}`;
  return `Runners · ${n} runner${n === 1 ? '' : 's'}${each}${elastic ? ` + ${elastic}` : ''}`;
}

export type HeadlinePart = { text: string; tone?: 'accent' | 'success' };

/** "5 agents working. 2 waiting on you." / "No agents working. Multi-currency invoices shipped." */
export function homeHeadline(input: { live: number; needsYou: number; shipped?: string | null }): HeadlinePart[] {
  const { live, needsYou, shipped } = input;
  const needs: HeadlinePart = { text: `${needsYou} waiting on you.`, tone: 'accent' };
  if (live > 0) {
    return [{ text: `${live} agent${live === 1 ? '' : 's'} working. ` }, needsYou > 0 ? needs : { text: 'Nothing waiting on you.' }];
  }
  if (shipped) return [{ text: `No agents working. ${shipped} ` }, { text: 'shipped', tone: 'success' }, { text: '.' }];
  return needsYou > 0 ? [{ text: 'No agents working. ' }, needs] : [{ text: 'No agents working. Nothing waiting on you.' }];
}

/** Midnight of `now`'s calendar day in `tz` (IANA), epoch ms. Invalid zone → UTC. */
export function startOfDayInZone(now: number, tz: string | null | undefined): number {
  let zone = tz || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const into = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 + (now % 1000);
  return now - into;
}
