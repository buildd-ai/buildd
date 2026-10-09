/**
 * The Missions Plan page, as data: for every open mission its start, what it
 * has done so far, when it should finish (p50) and when it would if it runs
 * long (p80), and which release that finish should make. Pure, so the rules
 * are tested without a DOM or a database.
 *
 * - A mission's finish is the end of the critical path through its unfinished
 *   tasks, scheduled with the Flow tab's own rules (lib/flow-timeline.ts: a
 *   running task keeps at least a quarter of its estimate, a gate adds the
 *   audit wait), using each task's frozen estimate.
 * - A mission a person has to move (a decision waiting on you, a held mission)
 *   has no finish. It says so; the number is never invented.
 * - A mission waiting on another starts after that mission's p50 finish.
 * - Release fit comes from the workspace's release config and recent release
 *   cadence. Under release-on-mission-completion it says that instead.
 * - Voice: "should" and "est."; never "late", because no deadline is committed.
 */
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { FLOW_AUDIT_WAIT_MS } from './flow-timeline';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A running task always has at least this share of its estimate left (as on the Flow tab). */
const MIN_REMAINING_SHARE = 0.25;
/** Releases needed before a cadence is trusted. */
const MIN_RELEASES_FOR_CADENCE = 3;
const MAX_CUTS = 8;
const MAX_AXIS_DAYS = 28;

export interface PlanTask {
  id: string;
  /** `tasks.status`; only `completed` counts as landed, failed and cancelled are not scheduled. */
  status: string;
  /** Task ids; ids outside the mission are ignored. */
  dependsOn: string[];
  /** Epoch ms of the first run, when one started. */
  startedAt: number | null;
  endedAt: number | null;
  p50Minutes: number | null;
  p80Minutes: number | null;
}

/** Who has to act before this mission can move: a person, or a hold. */
export type PlanBlock = 'you' | 'held' | null;

export interface PlanMissionInput {
  id: string;
  title: string;
  href: string;
  workspaceId: string | null;
  /** From the escalation-gate verdict the list and Home read (delivery kind), never a rule of this page's own. */
  blocked: PlanBlock;
  dependsOnMissionId: string | null;
  tasks: PlanTask[];
}

export type NoEstimateReason = 'waiting_on_you' | 'held' | 'no_estimate' | 'after_unknown' | 'landed';

export type ReleaseFit =
  | { kind: 'cut'; cutAt: number; index: number; atRisk: boolean; laterCutAt: number | null; version: string | null }
  | { kind: 'beyond' }
  | { kind: 'on_completion' };

export interface PlanRow {
  id: string;
  title: string;
  href: string;
  workspaceId: string | null;
  /** Epoch ms the mission started, or is estimated to. */
  start: number;
  /** Where the solid part ends (now), when it has started. */
  soFarEnd: number | null;
  /** Estimated finish; null when there is none to give. */
  p50: number | null;
  /** If it runs long. */
  p80: number | null;
  noEstimate: NoEstimateReason | null;
  /** The open mission this one waits on. */
  afterId: string | null;
  afterTitle: string | null;
  /** Epoch ms the dependency should finish, for the elbow. */
  afterEnd: number | null;
  fit: ReleaseFit | null;
}

// ── a mission's own schedule ────────────────────────────────────────────────

const landed = (t: PlanTask) => t.status === 'completed';
const schedulable = (t: PlanTask) => !landed(t) && t.status !== 'failed' && t.status !== 'cancelled';
const ms = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * MIN : null);

/** When the mission's last unfinished task ends, scheduling each from `now` after its gates. Null: nothing to estimate. */
function finishOf(tasks: readonly PlanTask[], now: number, pick: 'p50' | 'p80'): number | null {
  const open = tasks.filter(schedulable);
  if (open.length === 0) return null;
  const byId = new Map(tasks.map(t => [t.id, t]));
  const ends = new Map<string, number>();
  const visiting = new Set<string>();
  const endOf = (id: string): number => {
    const known = ends.get(id);
    if (known != null) return known;
    const t = byId.get(id)!;
    if (!schedulable(t)) return t.endedAt ?? now;
    visiting.add(id);
    const gates = t.dependsOn.filter(d => byId.has(d) && !visiting.has(d)).map(d => endOf(d) + (schedulable(byId.get(d)!) ? FLOW_AUDIT_WAIT_MS : 0));
    visiting.delete(id);
    const p50 = ms(t.p50Minutes);
    const est = (pick === 'p80' ? ms(t.p80Minutes) ?? p50 : p50) ?? 0;
    let end: number;
    if (t.startedAt != null) {
      const left = Math.max(est - (now - t.startedAt), est * MIN_REMAINING_SHARE);
      end = Math.max(now + left, ...gates);
    } else {
      end = Math.max(now, ...gates) + est;
    }
    ends.set(id, end);
    return end;
  };
  return Math.max(...open.map(t => endOf(t.id)));
}

/** True when at least one unfinished task has an estimate: without one, "finish" would be a guess. */
const hasEstimate = (tasks: readonly PlanTask[]) => tasks.filter(schedulable).some(t => ms(t.p50Minutes) != null);

/**
 * One row per open mission, ordered by estimated finish (earliest first; no
 * estimate last, in title order). `plans` maps workspace id to its release plan.
 */
export function planMissions(inputs: readonly PlanMissionInput[], now: number, plans: ReadonlyMap<string, ReleasePlan> = new Map()): PlanRow[] {
  const byId = new Map(inputs.map(m => [m.id, m]));
  const memo = new Map<string, PlanRow>();
  const visiting = new Set<string>();

  const place = (m: PlanMissionInput): PlanRow => {
    const known = memo.get(m.id);
    if (known) return known;
    visiting.add(m.id);
    const dep = m.dependsOnMissionId && byId.has(m.dependsOnMissionId) && !visiting.has(m.dependsOnMissionId)
      ? place(byId.get(m.dependsOnMissionId)!)
      : null;
    visiting.delete(m.id);

    const startedAts = m.tasks.map(t => t.startedAt).filter((v): v is number => v != null);
    const began = startedAts.length > 0 ? Math.min(...startedAts) : null;
    const row: PlanRow = {
      id: m.id, title: m.title, href: m.href, workspaceId: m.workspaceId,
      start: began ?? now, soFarEnd: began != null ? now : null,
      p50: null, p80: null, noEstimate: null,
      afterId: dep?.id ?? null, afterTitle: dep?.title ?? null, afterEnd: dep?.p50 ?? null,
      fit: null,
    };

    if (m.blocked === 'you') row.noEstimate = 'waiting_on_you';
    else if (m.blocked === 'held') row.noEstimate = 'held';
    else if (!m.tasks.some(schedulable)) row.noEstimate = 'landed';
    else if (!hasEstimate(m.tasks)) row.noEstimate = 'no_estimate';
    else if (dep && (dep.p50 == null || dep.p80 == null)) row.noEstimate = 'after_unknown';
    else {
      const f50 = finishOf(m.tasks, now, 'p50');
      const f80 = finishOf(m.tasks, now, 'p80');
      if (f50 != null && f80 != null) {
        if (dep && dep.p50 != null && dep.p80 != null) {
          // Starts once the other mission should be done; its own length is unchanged.
          row.start = Math.max(now, dep.p50 + FLOW_AUDIT_WAIT_MS);
          row.soFarEnd = null;
          row.p50 = row.start + (f50 - now);
          row.p80 = Math.max(now, dep.p80 + FLOW_AUDIT_WAIT_MS) + (f80 - now);
        } else {
          row.p50 = f50;
          row.p80 = Math.max(f80, f50);
        }
      }
    }
    const plan = (m.workspaceId && plans.get(m.workspaceId)) || { mode: 'none' as const };
    row.fit = releaseFit(row.p50, row.p80, plan);
    memo.set(m.id, row);
    return row;
  };

  const rows = inputs.map(place);
  return rows.sort((a, b) => {
    if ((a.p50 == null) !== (b.p50 == null)) return a.p50 == null ? 1 : -1;
    return (a.p50 ?? 0) - (b.p50 ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

// ── release fit ─────────────────────────────────────────────────────────────

export type ReleasePlan =
  | { mode: 'none' }
  | { mode: 'on_completion' }
  | { mode: 'cuts'; cuts: number[]; latestVersion: string | null };

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** `v0.312.1` → the version `index` cuts on, `v0.313` for the first: the next minor. Null when the version isn't that shape. */
export function cutVersion(latest: string | null | undefined, index: number): string | null {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(latest?.trim() ?? '');
  return m ? `v${m[1]}.${Number(m[2]) + 1 + index}` : null;
}

/**
 * The workspace's next release cuts, projected from how it released lately:
 * the weekday it keeps releasing on when there is one, otherwise the median
 * gap. No releases to learn from, or releases off, means no cuts.
 */
export function projectReleaseCuts(input: {
  config: Pick<WorkspaceReleaseConfig, 'enabled' | 'trigger'> | null | undefined;
  /** Epoch ms of recent releases, any order. */
  releaseTimes: readonly number[];
  latestVersion?: string | null;
  now: number;
}): ReleasePlan {
  const { config, now } = input;
  if (!config?.enabled) return { mode: 'none' };
  if (config.trigger === 'on_mission_complete') return { mode: 'on_completion' };
  const times = [...input.releaseTimes].sort((a, b) => a - b).slice(-8);
  if (times.length < MIN_RELEASES_FOR_CADENCE) return { mode: 'none' };

  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const gap = median(gaps);
  if (!(gap > 0)) return { mode: 'none' };
  const last = times[times.length - 1];
  const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
  const dow = (t: number) => new Date(t).getUTCDay();
  const timeOfDay = median(times.map(t => t - dayStart(t)));

  const counts = new Map<number, number>();
  for (const t of times) counts.set(dow(t), (counts.get(dow(t)) ?? 0) + 1);
  const [modeDay, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];

  const cuts: number[] = [];
  if (gap >= 4 * DAY && modeCount / times.length >= 0.6) {
    const step = Math.max(7, Math.round(gap / (7 * DAY)) * 7) * DAY;
    let offset = (modeDay - dow(last) + 7) % 7;
    if (offset === 0) offset = step / DAY;
    let c = dayStart(last) + offset * DAY + timeOfDay;
    while (c <= now) c += step;
    for (; cuts.length < MAX_CUTS; c += step) cuts.push(c);
  } else {
    const step = Math.max(gap, 6 * HOUR);
    let c = last + step;
    while (c <= now) c += step;
    for (; cuts.length < MAX_CUTS; c += step) cuts.push(c);
  }
  return { mode: 'cuts', cuts, latestVersion: input.latestVersion ?? null };
}

/** The first cut at or after a mission's p50; "at risk" when its p80 falls after that cut. */
export function releaseFit(p50: number | null, p80: number | null, plan: ReleasePlan): ReleaseFit | null {
  if (plan.mode === 'none' || p50 == null) return null;
  if (plan.mode === 'on_completion') return { kind: 'on_completion' };
  const index = plan.cuts.findIndex(c => c >= p50);
  if (index < 0) return { kind: 'beyond' };
  const cutAt = plan.cuts[index];
  const atRisk = p80 != null && p80 > cutAt;
  const later = atRisk ? plan.cuts.find(c => c >= (p80 as number)) ?? null : null;
  return { kind: 'cut', cutAt, index, atRisk, laterCutAt: later, version: cutVersion(plan.latestVersion, index) };
}

// ── words ───────────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Friday`, or `Oct 16` once it is more than a week out. */
function dayWord(at: number, now: number): string {
  const d = new Date(at);
  return at - now > 6 * DAY ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : DAYS[d.getUTCDay()];
}
const shortDay = (at: number, now: number) => {
  const w = dayWord(at, now);
  return w.length > 3 && DAYS.includes(w) ? w.slice(0, 3) : w;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface PlanLede {
  headline: string;
  detail: string | null;
}

/**
 * One sentence on how many missions should make the next release, and one
 * line on what is holding the rest: an at-risk mission, or people owed a reply.
 */
export function planLede(rows: readonly PlanRow[], plans: ReadonlyMap<string, ReleasePlan>, now: number): PlanLede {
  if (rows.length === 0) return { headline: 'No open missions.', detail: null };
  const youBlocked = rows.filter(r => r.noEstimate === 'waiting_on_you');
  const youLine = youBlocked.length > 0
    ? `${plural(youBlocked.length, 'mission is', 'missions are')} waiting on you and ${youBlocked.length === 1 ? 'has' : 'have'} no estimate.`
    : null;

  const modes = [...plans.values()].map(p => p.mode);
  const cutFits = rows.flatMap(r => (r.fit?.kind === 'cut' ? [{ r, fit: r.fit }] : []));
  if (cutFits.length === 0) {
    if (modes.length > 0 && modes.every(m => m === 'on_completion')) {
      return { headline: 'This workspace releases when a mission completes, so each one ships as it finishes.', detail: youLine };
    }
    const est = rows.filter(r => r.p50 != null).length;
    return {
      headline: est === 0 ? 'No open mission has an estimate yet.' : `${plural(est, 'mission has', 'missions have')} an estimate; no release cut is known for ${est === 1 ? 'it' : 'them'}.`,
      detail: youLine,
    };
  }

  const target = Math.min(...cutFits.map(f => f.fit.cutAt));
  const makeIt = cutFits.filter(f => f.fit.cutAt === target && !f.fit.atRisk).length;
  const word = dayWord(target, now);
  const headline = makeIt === 0
    ? `No mission should make ${word}'s release.`
    : `${plural(makeIt, 'mission', 'missions')} should make ${word}'s release.`;

  const risky = cutFits.find(f => f.fit.atRisk);
  let detail: string | null = null;
  if (risky) {
    const cutWord = dayWord(risky.fit.cutAt, now);
    const later = risky.fit.laterCutAt;
    const landing = later == null
      ? ''
      : new Date(later).getUTCDay() === new Date(risky.fit.cutAt).getUTCDay()
        ? `, and would probably land in the ${DAYS[new Date(later).getUTCDay()]} after`
        : `, and would probably land in ${dayWord(later, now)}'s`;
    detail = `${risky.r.title} should finish before ${cutWord}'s cut but may run past it${landing}.`;
  }
  return { headline, detail: detail ?? youLine };
}

/** The right-hand column: `Fri → v0.302 · at risk`, `waiting on you`, `after Workflow kernel`. */
export function planRowLabel(row: PlanRow, now: number): string {
  if (row.noEstimate === 'waiting_on_you') return 'waiting on you';
  if (row.noEstimate === 'held') return 'held';
  const parts: string[] = [];
  const fit = row.fit;
  if (fit?.kind === 'on_completion') parts.push('ships on completion');
  else if (fit?.kind === 'beyond') parts.push('past the next cuts');
  else if (fit?.kind === 'cut') {
    const cut = fit.version ? `${shortDay(fit.cutAt, now)} → ${fit.version}` : shortDay(fit.cutAt, now);
    parts.push(fit.atRisk ? `${cut} · at risk` : cut);
  }
  if (row.afterTitle) parts.push(`after ${row.afterTitle}`);
  if (parts.length === 0) {
    if (row.noEstimate === 'landed') return 'all tasks landed';
    if (row.noEstimate === 'no_estimate') return 'no estimate yet';
    return 'no estimate';
  }
  return parts.join(' · ');
}

// ── the axis ────────────────────────────────────────────────────────────────

export interface PlanAxisDay {
  /** Epoch ms of UTC midnight. */
  at: number;
  label: string;
  date: number;
  weekend: boolean;
}

export interface PlanAxis {
  from: number;
  to: number;
  days: PlanAxisDay[];
  /** Fraction of the window, clamped to 0..1. */
  at: (t: number) => number;
}

/** A calendar window of whole UTC days from the earliest start to past the last finish and the first release cut. */
export function planAxis(rows: readonly PlanRow[], cuts: readonly number[], now: number): PlanAxis {
  const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
  const starts = rows.map(r => r.start);
  const ends = rows.flatMap(r => [r.p50, r.p80]).filter((v): v is number => v != null);
  const nextCut = cuts.find(c => c >= now);
  const from = dayStart(Math.min(now, ...starts));
  const last = Math.max(now + 3 * DAY, ...ends, ...(nextCut != null ? [nextCut] : []));
  const to = Math.min(dayStart(last) + DAY, from + MAX_AXIS_DAYS * DAY);
  const days: PlanAxisDay[] = [];
  for (let t = from; t < to; t += DAY) {
    const d = new Date(t);
    days.push({ at: t, label: DAYS[d.getUTCDay()].slice(0, 3), date: d.getUTCDate(), weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6 });
  }
  const span = to - from;
  return { from, to, days, at: (t: number) => Math.min(1, Math.max(0, (t - from) / span)) };
}
