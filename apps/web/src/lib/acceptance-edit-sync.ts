/**
 * Flag a building task's PR that edits or deletes an acceptance test (spec R-80,
 * AC-126): record it on the task, say so on the PR and on the mission page, and
 * leave it to a person to accept (the accept route). The hold itself is in the
 * outcome fold (`dropUnacceptedTestResults`). Called on every PR sync; the
 * decision is pure (@buildd/spec-contract/acceptance-edit), this does the I/O.
 */
import {
  acceptanceEditOf, acceptanceTestPaths, applyStrictnessChecks, dropStaleAutoAccepts, flagAcceptanceEdit, heldReasons, pendingAcceptance,
  type AcceptanceEditFlag, type StrictnessCheck,
} from '@buildd/spec-contract/acceptance-edit';
import { compareAcceptanceStrictness } from '@buildd/spec-contract/acceptance-strictness';

export interface AcceptanceEditDeps {
  /** The task whose worker owns this PR, or null. */
  taskOfPr: () => Promise<{ id: string; missionId: string | null; roleSlug: string | null; context: unknown; workspaceId?: string } | null>;
  changedFiles: () => Promise<string[]>;
  /** A test file before the PR (at the merge base) and at its head; null where it does not exist. Absent = no strictness check. */
  readSources?: (path: string) => Promise<{ before: string | null; after: string | null }>;
  /** Whether the workspace keeps the strictness check on (default on). */
  strictnessOn?: () => Promise<boolean>;
  /** Replace the task's flag, or clear it with null. */
  saveFlag: (taskId: string, flag: AcceptanceEditFlag | null) => Promise<void>;
  missionNote: (missionId: string, taskId: string, title: string, body: string) => Promise<void>;
  prComment: (body: string) => Promise<void>;
  now?: () => string;
}

/** The strictness check is on unless a workspace opts out: `gitConfig.livingSpecs.acceptanceStrictness: false`. */
export function acceptanceStrictnessOn(gitConfig: unknown): boolean {
  const ls = (gitConfig as { livingSpecs?: unknown } | null)?.livingSpecs;
  return !(ls && typeof ls === 'object' && (ls as { acceptanceStrictness?: unknown }).acceptanceStrictness === false);
}

export const isBuildingRole = (roleSlug: string | null | undefined): boolean => (roleSlug ?? '').trim().toLowerCase() === 'builder';

/** Paths of acceptance tests still awaiting a person's accept, over a mission's tasks. Only building tasks carry the flag; the role is matched as the setter does. */
export function unacceptedPathsOf(rows: Array<{ roleSlug: string | null; context: unknown }>): string[] {
  return rows.filter((t) => isBuildingRole(t.roleSlug)).flatMap((t) => pendingAcceptance(acceptanceEditOf(t.context)));
}

export function flagText(paths: readonly string[], prNumber: number, flag?: AcceptanceEditFlag | null): { title: string; body: string } {
  const list = paths.map((p) => [`- \`${p}\``, ...heldReasons(flag, p).map((r) => `  - ${r}`)].join('\n')).join('\n');
  return {
    title: `PR #${prNumber} changes an acceptance test`,
    body: `A building task's PR edits or deletes an acceptance test:\n${list}\n\nTest results do not count toward this task's outcome until a person accepts the change.`,
  };
}

/** Returns what happened, for logs and tests. Never throws on the I/O; a failed read leaves the flag as it was. */
export async function syncAcceptanceEdit(
  input: { prNumber: number; headSha: string },
  deps: AcceptanceEditDeps,
): Promise<'not_building' | 'unchanged' | 'cleared' | 'flagged' | 'auto_accepted' | 'read_failed'> {
  const task = await deps.taskOfPr();
  if (!task || !isBuildingRole(task.roleSlug)) return 'not_building';
  let files: string[];
  try { files = await deps.changedFiles(); } catch { return 'read_failed'; }
  const prev = acceptanceEditOf(task.context);
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const flagged = flagAcceptanceEdit(dropStaleAutoAccepts(prev, input.headSha), acceptanceTestPaths(files), input.headSha, now);
  const next = flagged && await checkStrictness(flagged, input.headSha, now, deps);
  if (!next) {
    if (!prev) return 'unchanged';
    await deps.saveFlag(task.id, null);
    return 'cleared';
  }
  await deps.saveFlag(task.id, next);
  const autoAccepted = next.acceptedPaths.length > (prev?.acceptedPaths.length ?? 0) && !pendingAcceptance(next).length;
  const before = new Set(pendingAcceptance(prev));
  const fresh = pendingAcceptance(next).filter((p) => !before.has(p));
  if (!fresh.length) return autoAccepted ? 'auto_accepted' : 'unchanged';
  const { title, body } = flagText(fresh, input.prNumber, next);
  if (task.missionId) await deps.missionNote(task.missionId, task.id, title, body).catch(() => {});
  await deps.prComment(body).catch(() => {});
  return 'flagged';
}

/**
 * Run the strictness check over the paths still pending at this head: stricter
 * or equivalent edits are accepted by the check; loosened, unreadable and any
 * failure to read the sources stay held. A failure never accepts.
 */
async function checkStrictness(flag: AcceptanceEditFlag, headSha: string, now: string, deps: AcceptanceEditDeps): Promise<AcceptanceEditFlag> {
  if (!deps.readSources) return flag;
  const todo = pendingAcceptance(flag).filter((p) => !flag.checks?.some((c) => c.path === p && c.headSha === headSha));
  if (!todo.length || (deps.strictnessOn && !(await deps.strictnessOn().catch(() => true)))) return flag;
  const checks: StrictnessCheck[] = [];
  for (const path of todo) {
    try {
      const { before, after } = await deps.readSources(path);
      const r = compareAcceptanceStrictness(before, after);
      const ok = r.verdict === 'stricter' || r.verdict === 'equivalent';
      checks.push({ path, headSha, verdict: r.verdict, autoAccepted: ok, weakened: r.weakened.map((w) => w.text), stricter: r.stricter, ...(r.reason ? { reason: r.reason } : {}) });
    } catch { /* unread sources: no finding, the edit stays held for a person */ }
  }
  return applyStrictnessChecks(flag, checks, now);
}
