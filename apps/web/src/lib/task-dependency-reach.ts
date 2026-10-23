/**
 * Who may name a task in `dependsOn`, and what each viewer is told about it
 * (Living Spec e28018c2, "Cross-workspace task dependencies within one team").
 *
 * An edge may cross workspaces inside one team. Three decisions live here, so
 * every route and surface makes them the same way:
 *
 *   - `checkDependencyReach`: create and update accept an id only when its
 *     task is in the dependent's team and the caller sees it (R-1 to R-3). A
 *     task in another team reads exactly like an id that does not exist.
 *   - `resolveDependencyHolders`: the one per-viewer resolver for an upstream
 *     a surface names (R-6 to R-9). A hidden upstream comes back with no
 *     title and no workspace, and every surface words it `HIDDEN_TASK_WORDS`.
 *     The task page, `explain` and the hold derivation read it; Health ›
 *     Queue must read it too when it is built.
 *   - `checkDependencyCycle`: update refuses an edge that closes a cycle,
 *     walking edges across the team's workspaces, bounded (R-16).
 *
 * "Sees" is the read rule the task's own GET applies: a person, membership of
 * the workspace's team; an account key or grant session,
 * `verifyAccountWorkspaceAccess`; a per-task token, its own workspace only. A
 * delegation grants filing, never reads, so it never counts here.
 *
 * Reads go through `ReachIo` so the rules are tested without a database.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import type { TaskScopedAccount } from '@/lib/task-token-auth';
import { HIDDEN_TASK_WORDS } from '@/lib/mission-task-hold';

/** Who is asking: a person's session, an account key, grant session or per-task token, or a surface only team members read. */
export type DependencyViewer =
  | { kind: 'person'; userId: string }
  | { kind: 'account'; account: Pick<TaskScopedAccount, 'id'> & Partial<TaskScopedAccount> }
  | { kind: 'member' };

/** The routes' caller: a key or token, when present, is the caller, as everywhere else. */
export function dependencyViewerOf(
  user: { id: string } | null | undefined,
  apiAccount: (Pick<TaskScopedAccount, 'id'> & Partial<TaskScopedAccount>) | null | undefined,
): DependencyViewer {
  if (apiAccount) return { kind: 'account', account: apiAccount };
  if (user) return { kind: 'person', userId: user.id };
  return { kind: 'member' };
}

/** The refusal for an id the caller cannot reach in the dependent's team, missing ids included (R-1, R-2). */
export const UNREACHABLE_DEPENDENCY_ERROR = 'dependsOn references tasks you cannot reach in this team';

/** How every surface names an upstream the viewer cannot see (R-6). */
export { HIDDEN_TASK_WORDS };

/** At most this many tasks are visited by the cycle walk (R-16). */
export const MAX_CYCLE_WALK = 500;

export interface ReachTaskRow {
  id: string;
  title: string | null;
  workspaceId: string;
  workspaceName: string | null;
  teamId: string | null;
  dependsOn: string[] | null;
}

export interface ReachIo {
  loadTasks(ids: readonly string[]): Promise<ReachTaskRow[]>;
  /** The caller's read check on a workspace, for a person or an account key (not a per-task token: decided here). */
  sees(viewer: DependencyViewer, workspaceId: string): Promise<boolean>;
}

const dbIo: ReachIo = {
  async loadTasks(ids) {
    if (ids.length === 0) return [];
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(inArray(tasks.id, [...ids])),
      columns: { id: true, title: true, workspaceId: true, dependsOn: true },
      with: { workspace: { columns: { name: true, teamId: true } } },
    });
    return (rows as Array<{ id: string; title: string | null; workspaceId: string; dependsOn: unknown; workspace?: { name: string | null; teamId: string | null } | null }>)
      .map(r => ({
        id: r.id,
        title: r.title,
        workspaceId: r.workspaceId,
        workspaceName: r.workspace?.name ?? null,
        teamId: r.workspace?.teamId ?? null,
        dependsOn: Array.isArray(r.dependsOn) ? (r.dependsOn as string[]) : [],
      }));
  },
  async sees(viewer, workspaceId) {
    if (viewer.kind === 'person') return !!(await verifyWorkspaceAccess(viewer.userId, workspaceId));
    if (viewer.kind === 'account') return verifyAccountWorkspaceAccess(viewer.account as TaskScopedAccount, workspaceId);
    return true;
  },
};

/**
 * Whether `viewer` sees tasks of `row`'s workspace. Outside `teamId` nothing
 * is seen: an edge never leaves the dependent's team. A per-task token sees
 * its own workspace only, whatever its delegation grants.
 */
function seer(viewer: DependencyViewer, teamId: string | null, io: ReachIo) {
  const memo = new Map<string, Promise<boolean>>();
  return (row: ReachTaskRow): Promise<boolean> => {
    if (teamId && row.teamId !== teamId) return Promise.resolve(false);
    if (viewer.kind === 'member') return Promise.resolve(true);
    if (viewer.kind === 'account' && viewer.account.taskScope) {
      return Promise.resolve(row.workspaceId === viewer.account.taskScope.workspaceId);
    }
    let hit = memo.get(row.workspaceId);
    if (!hit) {
      hit = io.sees(viewer, row.workspaceId).catch(() => false);
      memo.set(row.workspaceId, hit);
    }
    return hit;
  };
}

export type DependencyReachResult = { ok: true } | { ok: false; error: string; ids: string[] };

/** R-1 to R-3: every id names a task of `teamId` the viewer sees. One message for unknown, other-team and unseen. */
export async function checkDependencyReach(
  input: { viewer: DependencyViewer; teamId: string | null; ids: readonly string[] },
  io: ReachIo = dbIo,
): Promise<DependencyReachResult> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return { ok: true };
  const rows = new Map((await io.loadTasks(ids)).map(r => [r.id, r]));
  const sees = seer(input.viewer, input.teamId, io);
  const unreachable: string[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r || !input.teamId || !(await sees(r))) unreachable.push(id);
  }
  return unreachable.length === 0
    ? { ok: true }
    : { ok: false, error: `${UNREACHABLE_DEPENDENCY_ERROR}: ${unreachable.join(', ')}`, ids: unreachable };
}

/** One upstream as a viewer may be told about it. */
export interface DependencyHolder {
  id: string;
  /** The viewer cannot see it: name it `HIDDEN_TASK_WORDS`, and say nothing else about it. */
  hidden: boolean;
  title: string | null;
  workspaceId: string | null;
  /** Set only for a visible upstream outside the dependent's own workspace. */
  workspaceName: string | null;
}

/**
 * The per-viewer resolver (R-6 to R-9): each id's upstream as `viewer` may
 * see it. An id with no row is left out, so a caller keeps its own reading of
 * a missing dependency. A failed read hides rather than names.
 */
export async function resolveDependencyHolders(
  scope: { viewer: DependencyViewer; teamId: string | null; dependentWorkspaceId: string | null },
  ids: readonly string[],
  io: ReachIo = dbIo,
): Promise<Map<string, DependencyHolder>> {
  const out = new Map<string, DependencyHolder>();
  const want = [...new Set(ids)];
  if (want.length === 0) return out;
  let rows: ReachTaskRow[];
  try {
    rows = await io.loadTasks(want);
  } catch {
    for (const id of want) out.set(id, { id, hidden: true, title: null, workspaceId: null, workspaceName: null });
    return out;
  }
  const sees = seer(scope.viewer, scope.teamId, io);
  for (const r of rows) {
    if (await sees(r)) {
      const elsewhere = !!scope.dependentWorkspaceId && r.workspaceId !== scope.dependentWorkspaceId;
      out.set(r.id, { id: r.id, hidden: false, title: r.title, workspaceId: r.workspaceId, workspaceName: elsewhere ? r.workspaceName : null });
    } else {
      out.set(r.id, { id: r.id, hidden: true, title: null, workspaceId: null, workspaceName: null });
    }
  }
  return out;
}

/** The facts a holder carries once resolved: a hidden one loses its title and every note. */
export function withHolderReach<T extends { title?: string | null }>(
  row: T,
  holder: DependencyHolder | undefined,
): T & { hidden?: boolean; workspaceName?: string | null } {
  if (!holder) return row;
  if (holder.hidden) return { ...row, title: null, hidden: true, workspaceName: null };
  return holder.workspaceName ? { ...row, workspaceName: holder.workspaceName } : row;
}

/**
 * R-16: refuse a `dependsOn` for `taskId` that would close a cycle, following
 * edges across every workspace of the team, visiting at most
 * `MAX_CYCLE_WALK` tasks. The refusal names the tasks on the cycle the caller
 * sees and counts the rest.
 */
export async function checkDependencyCycle(
  input: { viewer: DependencyViewer; teamId: string | null; taskId: string; dependsOn: readonly string[] },
  io: ReachIo = dbIo,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const start = [...new Set(input.dependsOn)].filter(id => id !== input.taskId);
  if (start.length === 0) return { ok: true };
  const parent = new Map<string, string | null>(start.map(id => [id, null]));
  const loaded = new Map<string, ReachTaskRow>();
  let frontier = start;
  while (frontier.length > 0) {
    if (loaded.size + frontier.length > MAX_CYCLE_WALK) return { ok: false, error: 'dependency chain too long to check' };
    const rows = await io.loadTasks(frontier);
    const next: string[] = [];
    for (const r of rows) {
      if (input.teamId && r.teamId !== input.teamId) continue;
      loaded.set(r.id, r);
      for (const dep of r.dependsOn ?? []) {
        if (dep === input.taskId) return { ok: false, error: await cycleError(pathTo(r.id, parent), loaded, input, io) };
        if (parent.has(dep)) continue;
        parent.set(dep, r.id);
        next.push(dep);
      }
    }
    frontier = next;
  }
  return { ok: true };
}

/** The walk from the new upstream down to `id`, in edge order. */
function pathTo(id: string, parent: ReadonlyMap<string, string | null>): string[] {
  const path: string[] = [];
  for (let cur: string | null | undefined = id; cur; cur = parent.get(cur)) path.unshift(cur);
  return path;
}

async function cycleError(
  path: readonly string[],
  loaded: ReadonlyMap<string, ReachTaskRow>,
  input: { viewer: DependencyViewer; teamId: string | null },
  io: ReachIo,
): Promise<string> {
  const sees = seer(input.viewer, input.teamId, io);
  const named: string[] = [];
  let hidden = 0;
  for (const id of path) {
    const r = loaded.get(id);
    if (r && (await sees(r))) named.push(`"${r.title ?? 'untitled task'}"`);
    else hidden += 1;
  }
  const rest = hidden === 0 ? null : hidden === 1 ? "1 task in a workspace you can't see" : `${hidden} tasks in workspaces you can't see`;
  const through = [named.join(', '), rest].filter(Boolean).join(' and ');
  return `would create a dependency cycle through ${through}`;
}
