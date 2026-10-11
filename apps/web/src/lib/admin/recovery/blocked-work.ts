/**
 * Blocked task-hours without double counting (operator-recovery spec §5.3, §5.5).
 *
 *  1. Each episode is an interval on one subject task, from its start to the
 *     earliest of its end, the subject's first progress, or now (the caller
 *     folds progress into `endMs`).
 *  2. Cascades go to the root: when a subject's blocker task is itself the
 *     subject of an open episode, the interval is attributed to the cause at
 *     the end of that chain. A cycle attributes once, to the cycle's cause.
 *  3. A task-instant counts toward exactly one cause. Inside one cause the
 *     task's intervals are unioned; across causes, when two roots block the
 *     same task at the same instant, the one `prefer` ranks higher wins.
 *  4. So the platform total (the union over tasks) equals the sum of the
 *     causes' attributed hours (OR-4).
 *  5. A downstream cause keeps only its unattributed hours and reports which
 *     root it waits behind.
 *
 * `unblocks` is the transitive closure of subjects downstream of a cause.
 *
 * Pure.
 */

export interface BlockEpisode {
  causeKey: string;
  subjectTaskId: string;
  /** The task holding the subject up (a blocker PR mapped to its task), if known. */
  blockerTaskId: string | null;
  startMs: number;
  /** Earliest of episode end and the subject's first progress. Null: still open. */
  endMs: number | null;
  /** The episode's cause is a path-overlap cycle (`path_overlap.cycle`). */
  cycle?: boolean;
}

export interface CauseBlockedWork {
  /** Hours attributed to this cause after root attribution and dedupe. */
  hours: number;
  /** Distinct subject tasks of this cause's open episodes. */
  blockedNow: Set<string>;
  /** Root cause → this cause's subject tasks that wait behind it. */
  waitsBehind: Map<string, Set<string>>;
}

export interface BlockedWorkResult {
  perCause: Map<string, CauseBlockedWork>;
  totalHours: number;
}

const HOUR_MS = 3_600_000;

function openEpisodesBySubject(episodes: ReadonlyArray<BlockEpisode>): Map<string, BlockEpisode[]> {
  const out = new Map<string, BlockEpisode[]>();
  for (const e of episodes) {
    if (e.endMs !== null) continue;
    const list = out.get(e.subjectTaskId) ?? [];
    list.push(e);
    out.set(e.subjectTaskId, list);
  }
  return out;
}

/** Lower is preferred. Ties fall back to causeKey so the result is total. */
export type CausePreference = (a: string, b: string) => number;

function pick(keys: Iterable<string>, prefer: CausePreference): string {
  let best: string | null = null;
  for (const k of keys) if (best === null || prefer(k, best) < 0 || (prefer(k, best) === 0 && k < best)) best = k;
  return best!;
}

/**
 * The root cause an open-graph walk from `episode` ends at. Only open episodes
 * form the blocker graph. A walk that revisits a task is a cycle: it goes to
 * the cycle's own cause (a `cycle` episode on the loop when there is one).
 */
export function rootCauseOf(episode: BlockEpisode, bySubject: Map<string, BlockEpisode[]>, prefer: CausePreference): string {
  const seen = new Set<string>([episode.subjectTaskId]);
  const path: BlockEpisode[] = [episode];
  const walk = (e: BlockEpisode): string[] => {
    const next = e.blockerTaskId ? bySubject.get(e.blockerTaskId) : undefined;
    if (!next || next.length === 0) return [e.causeKey];
    const roots: string[] = [];
    for (const n of next) {
      if (seen.has(n.subjectTaskId)) {
        const loopStart = path.findIndex(p => p.subjectTaskId === n.subjectTaskId);
        const loop = path.slice(Math.max(0, loopStart));
        const cyc = loop.filter(p => p.cycle).map(p => p.causeKey);
        roots.push(pick(cyc.length ? cyc : loop.map(p => p.causeKey), prefer));
        continue;
      }
      seen.add(n.subjectTaskId);
      path.push(n);
      roots.push(...walk(n));
      path.pop();
      seen.delete(n.subjectTaskId);
    }
    return roots;
  };
  return pick(walk(episode), prefer);
}

export function computeBlockedWork(input: {
  episodes: ReadonlyArray<BlockEpisode>;
  windowStartMs: number;
  nowMs: number;
  prefer: CausePreference;
}): BlockedWorkResult {
  const { episodes, windowStartMs, nowMs, prefer } = input;
  const bySubject = openEpisodesBySubject(episodes);
  const perCause = new Map<string, CauseBlockedWork>();
  const entry = (k: string) => {
    let e = perCause.get(k);
    if (!e) { e = { hours: 0, blockedNow: new Set(), waitsBehind: new Map() }; perCause.set(k, e); }
    return e;
  };

  // Segments per task, each labelled with the cause it is attributed to.
  const segments = new Map<string, Array<{ from: number; to: number; cause: string }>>();
  for (const e of episodes) {
    entry(e.causeKey);
    const root = e.endMs === null ? rootCauseOf(e, bySubject, prefer) : e.causeKey;
    entry(root);
    if (e.endMs === null) entry(e.causeKey).blockedNow.add(e.subjectTaskId);
    if (root !== e.causeKey) {
      const w = entry(e.causeKey).waitsBehind;
      const set = w.get(root) ?? new Set<string>();
      set.add(e.subjectTaskId);
      w.set(root, set);
    }
    const from = Math.max(e.startMs, windowStartMs);
    const to = Math.min(e.endMs ?? nowMs, nowMs);
    if (to <= from) continue;
    const list = segments.get(e.subjectTaskId) ?? [];
    list.push({ from, to, cause: root });
    segments.set(e.subjectTaskId, list);
  }

  // Elementary sweep per task: each instant goes to one cause.
  let totalMs = 0;
  for (const list of segments.values()) {
    const points = [...new Set(list.flatMap(s => [s.from, s.to]))].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const active = list.filter(s => s.from <= a && s.to >= b).map(s => s.cause);
      if (active.length === 0) continue;
      const winner = pick(new Set(active), prefer);
      entry(winner).hours += (b - a) / HOUR_MS;
      totalMs += b - a;
    }
  }
  return { perCause, totalHours: totalMs / HOUR_MS };
}

/** §5.5: every task downstream of `causeKey` in the open blocker graph, its own subjects included. */
export function unblocksOf(causeKey: string, episodes: ReadonlyArray<BlockEpisode>): Set<string> {
  const open = episodes.filter(e => e.endMs === null);
  const byBlocker = new Map<string, string[]>();
  for (const e of open) {
    if (!e.blockerTaskId) continue;
    const list = byBlocker.get(e.blockerTaskId) ?? [];
    list.push(e.subjectTaskId);
    byBlocker.set(e.blockerTaskId, list);
  }
  const out = new Set(open.filter(e => e.causeKey === causeKey).map(e => e.subjectTaskId));
  const queue = [...out];
  while (queue.length) {
    const t = queue.shift()!;
    for (const s of byBlocker.get(t) ?? []) if (!out.has(s)) { out.add(s); queue.push(s); }
  }
  return out;
}
