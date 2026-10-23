/**
 * Who a piece of work is for and who filed it, as Activity shows it (spec
 * 9430a28f R-4, AC-4). Pure and client-safe.
 *
 * Read only from the lineage the database records: `tasks.createdByUserId`
 * with `tasks.requesterSource`, which the requester trigger writes on insert
 * (core/task-requester-source.ts), and `createdByWorkerId` for an agent filer.
 * A person named with no record of how they were decided, a backfill that
 * could not decide, and work with no person all read "Unattributed". Nothing
 * is guessed from the runner, the API key or team membership.
 *
 * The identity filters are offered only when they can be answered: a known
 * viewer and some recorded lineage in view. "All" always keeps unattributed
 * work; the narrower filters say how much unattributed work they leave out.
 */

export interface AttributionInput {
  createdByUserId?: string | null;
  requesterSource?: string | null;
  createdByWorkerId?: string | null;
}

export interface Attribution {
  /** Recorded lineage names the accountable person. */
  known: boolean;
  requester: { id: string; name: string | null; you: boolean } | null;
  /** Who filed it, when recorded: the person themselves, an agent or a schedule. */
  filedBy: 'requester' | 'agent' | 'schedule' | null;
  text: string;
}

/** Sources that decided a person: live trigger paths, and backfills that found one. */
export const DECIDED_REQUESTER_SOURCES = ['explicit', 'parent', 'mission', 'schedule', 'backfill_parent', 'backfill_mission', 'backfill_schedule'] as const;
const DECIDED: ReadonlySet<string> = new Set(DECIDED_REQUESTER_SOURCES);

export const UNATTRIBUTED: Attribution = { known: false, requester: null, filedBy: null, text: 'Unattributed' };

export function attributionOf(t: AttributionInput, viewerUserId: string | null, names: ReadonlyMap<string, string>): Attribution {
  const src = t.requesterSource ?? null;
  const id = t.createdByUserId ?? null;
  if (!id || !src || !DECIDED.has(src)) return UNATTRIBUTED;
  const you = viewerUserId != null && id === viewerUserId;
  const name = names.get(id) ?? null;
  const who = you ? 'you' : name ?? 'a teammate';
  if (src === 'explicit') return { known: true, requester: { id, name, you }, filedBy: 'requester', text: `Filed by ${who}` };
  const filedBy = t.createdByWorkerId ? 'agent' as const : src === 'schedule' || src === 'backfill_schedule' ? 'schedule' as const : null;
  const by = filedBy === 'agent' ? ' · filed by an agent' : filedBy === 'schedule' ? ' · from a schedule' : '';
  return { known: true, requester: { id, name, you }, filedBy, text: `For ${who}${by}` };
}

export type ActivityWho = 'all' | 'for-me' | 'filed-by-me';

export function matchesWho(a: Attribution | null | undefined, who: ActivityWho): boolean {
  if (who === 'all') return true;
  if (!a?.known || !a.requester?.you) return false;
  return who === 'for-me' || a.filedBy === 'requester';
}

/** The identity filters can be answered: a known viewer, and some work in view with recorded lineage. */
export function whoFiltersReliable(items: ReadonlyArray<Attribution | null | undefined>, viewerUserId: string | null): boolean {
  return viewerUserId != null && items.some(a => a?.known);
}
