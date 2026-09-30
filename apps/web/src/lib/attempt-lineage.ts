/**
 * Lineage of a fix-attempt chain: the task that opened a PR, the `after CI #N`
 * / `after review #N` attempts spawned from it, and the attempts spawned from
 * those. A resumed attempt that could not reuse the branch opens a PR of its
 * own, so the chain spans several PR numbers; `explain` on any of them, or on
 * any task in the chain, has to reach the same history.
 *
 * Two mechanisms, deliberately redundant:
 *  - `collectLineage` walks `parentTaskId` (authoritative, always present);
 *  - `lineageStamp` writes `rootTaskId` and `lineagePrNumbers` into each
 *    attempt's context at creation, so the chain is greppable and survives
 *    a parent row that has since been deleted.
 */

export const LINEAGE_MAX_DEPTH = 10;
export const LINEAGE_MAX_TASKS = 80;

export interface LineageStamp {
  rootTaskId: string;
  lineagePrNumbers: number[];
}

/**
 * What a new attempt records about the chain it joins. `parent` is the task the
 * attempt was spawned for; its own stamp (when it is itself an attempt) is
 * carried forward and the PR being fixed is appended.
 */
export function lineageStamp(
  parent: { id: string; context: Record<string, unknown> | null | undefined },
  prNumbers: ReadonlyArray<number | null | undefined>,
): LineageStamp {
  const ctx = parent.context ?? {};
  const rootTaskId = typeof ctx.rootTaskId === 'string' && ctx.rootTaskId ? ctx.rootTaskId : parent.id;
  const inherited = Array.isArray(ctx.lineagePrNumbers)
    ? (ctx.lineagePrNumbers as unknown[]).filter((n): n is number => typeof n === 'number')
    : [];
  const own = typeof ctx.prNumber === 'number' ? [ctx.prNumber] : [];
  const added = prNumbers.filter((n): n is number => typeof n === 'number');
  return { rootTaskId, lineagePrNumbers: [...new Set([...inherited, ...own, ...added])] };
}

interface LineageRow {
  id: string;
  parentTaskId: string | null;
  taskClass?: string | null;
}

/**
 * Every task in the chain `taskId` belongs to: walk up through attempt parents
 * to the top, then down through attempt children. Reads are batched per level.
 * Bounded by depth and total size so a malformed cycle cannot run away.
 */
export async function collectLineage<T extends LineageRow>(
  taskId: string,
  io: {
    fetchTask: (id: string) => Promise<T | null>;
    fetchChildren: (parentIds: string[]) => Promise<T[]>;
  },
): Promise<T[]> {
  const start = await io.fetchTask(taskId);
  if (!start) return [];

  let root = start;
  const seen = new Set<string>([start.id]);
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth++) {
    if (root.taskClass !== 'attempt' || !root.parentTaskId || seen.has(root.parentTaskId)) break;
    const parent = await io.fetchTask(root.parentTaskId);
    if (!parent) break;
    seen.add(parent.id);
    root = parent;
  }

  const all = new Map<string, T>([[root.id, root]]);
  let frontier = [root.id];
  for (let depth = 0; depth < LINEAGE_MAX_DEPTH && frontier.length > 0 && all.size < LINEAGE_MAX_TASKS; depth++) {
    const children = await io.fetchChildren(frontier);
    frontier = [];
    for (const c of children) {
      if (c.taskClass !== 'attempt' || all.has(c.id)) continue;
      all.set(c.id, c);
      frontier.push(c.id);
      if (all.size >= LINEAGE_MAX_TASKS) break;
    }
  }
  return [...all.values()];
}
