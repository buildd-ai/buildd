/**
 * Home's glyph ticker: one row per event (claimed, PR opened, merged, asked,
 * failed, mission done), newest first, with no repeated "via … · builder · …"
 * prose. Consecutive identical rows (a heartbeat mission's ticks) collapse to
 * one row with a count.
 *
 * Pure and client-safe.
 */
import { missionTaskHref } from './mission-task-href';
import { taskShortLabel } from './segment-label';

type DateLike = Date | string | null | undefined;

export type TickerKind = 'claim' | 'pr' | 'merged' | 'question' | 'failed' | 'mission';

export interface TickerEvent {
  id: string;
  at: number;
  kind: TickerKind;
  /** The bold word: a task name, `#413`, "question", "mission". */
  label: string;
  /** The rest of the row: `→ dune`, the task name, a mission title. */
  detail: string;
  /** Right-aligned fact: "claimed", "+318 −0", "merged", "asks you". */
  right: string;
  href: string | null;
  /** Rows folded into this one (identical consecutive events). */
  count: number;
}

export interface TickerWorkerRow {
  id: string;
  status: string;
  startedAt?: DateLike;
  completedAt?: DateLike;
  updatedAt?: DateLike;
  mergedAt?: DateLike;
  prNumber?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  /** Runner display name, resolved by the caller (fleet snapshot). */
  runnerName?: string | null;
  task?: { id: string; title: string; label?: string | null; mode?: string | null; missionId?: string | null } | null;
}

export interface TickerMissionRow {
  id: string;
  title: string;
  completedAt?: DateLike;
}

const ms = (d: DateLike) => (d == null ? NaN : new Date(d).getTime());

export function buildTickerEvents(
  workers: readonly TickerWorkerRow[],
  missions: readonly TickerMissionRow[],
  opts: { since?: number; limit?: number } = {},
): TickerEvent[] {
  const since = opts.since ?? -Infinity;
  const raw: TickerEvent[] = [];
  const push = (e: Omit<TickerEvent, 'count'>) => {
    if (Number.isFinite(e.at) && e.at >= since) raw.push({ ...e, count: 1 });
  };

  for (const w of workers) {
    const t = w.task ?? null;
    const name = t ? taskShortLabel(t).label : 'task';
    const href = t ? missionTaskHref({ missionId: t.missionId ?? null, taskId: t.id, from: 'home', mode: 'sheet' }) : null;
    push({ id: `${w.id}:claim`, at: ms(w.startedAt), kind: 'claim', label: name, detail: w.runnerName ? `→ ${w.runnerName}` : '', right: 'claimed', href });
    if (w.prNumber) {
      const opened = ms(w.completedAt) || ms(w.updatedAt);
      const diff = w.linesAdded != null || w.linesRemoved != null ? `+${w.linesAdded ?? 0} −${w.linesRemoved ?? 0}` : 'PR opened';
      push({ id: `${w.id}:pr`, at: opened, kind: 'pr', label: `#${w.prNumber}`, detail: name, right: diff, href });
      if (w.mergedAt) push({ id: `${w.id}:merged`, at: ms(w.mergedAt), kind: 'merged', label: `#${w.prNumber}`, detail: name, right: 'merged', href });
    }
    if (w.status === 'waiting_input') {
      push({ id: `${w.id}:question`, at: ms(w.updatedAt), kind: 'question', label: 'question', detail: name, right: 'asks you', href });
    }
    if (w.status === 'failed' || w.status === 'error') {
      push({ id: `${w.id}:failed`, at: ms(w.completedAt) || ms(w.updatedAt), kind: 'failed', label: name, detail: '', right: 'failed', href });
    }
  }
  for (const m of missions) {
    push({ id: `${m.id}:done`, at: ms(m.completedAt), kind: 'mission', label: 'mission', detail: m.title, right: 'mission done', href: `/app/missions/${encodeURIComponent(m.id)}?from=home` });
  }

  raw.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const out: TickerEvent[] = [];
  for (const e of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === e.kind && prev.label === e.label && prev.detail === e.detail && prev.right === e.right) {
      prev.count++;
      continue;
    }
    out.push(e);
  }
  return out.slice(0, opts.limit ?? 12);
}
