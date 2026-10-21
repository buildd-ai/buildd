/**
 * Flag a building task's PR that edits or deletes an acceptance test (spec R-80,
 * AC-126): record it on the task, say so on the PR and on the mission page, and
 * leave it to a person to accept (the accept route). The hold itself is in the
 * outcome fold (`dropUnacceptedTestResults`). Called on every PR sync; the
 * decision is pure (@buildd/spec-contract/acceptance-edit), this does the I/O.
 */
import {
  acceptanceEditOf, acceptanceTestPaths, flagAcceptanceEdit, pendingAcceptance, type AcceptanceEditFlag,
} from '@buildd/spec-contract/acceptance-edit';

export interface AcceptanceEditDeps {
  /** The task whose worker owns this PR, or null. */
  taskOfPr: () => Promise<{ id: string; missionId: string | null; roleSlug: string | null; context: unknown } | null>;
  changedFiles: () => Promise<string[]>;
  /** Replace the task's flag, or clear it with null. */
  saveFlag: (taskId: string, flag: AcceptanceEditFlag | null) => Promise<void>;
  missionNote: (missionId: string, taskId: string, title: string, body: string) => Promise<void>;
  prComment: (body: string) => Promise<void>;
  now?: () => string;
}

export const isBuildingRole = (roleSlug: string | null | undefined): boolean => (roleSlug ?? '').trim().toLowerCase() === 'builder';

/** Paths of acceptance tests still awaiting a person's accept, over a mission's tasks. Only building tasks carry the flag; the role is matched as the setter does. */
export function unacceptedPathsOf(rows: Array<{ roleSlug: string | null; context: unknown }>): string[] {
  return rows.filter((t) => isBuildingRole(t.roleSlug)).flatMap((t) => pendingAcceptance(acceptanceEditOf(t.context)));
}

export function flagText(paths: readonly string[], prNumber: number): { title: string; body: string } {
  const list = paths.map((p) => `- \`${p}\``).join('\n');
  return {
    title: `PR #${prNumber} changes an acceptance test`,
    body: `A building task's PR edits or deletes an acceptance test:\n${list}\n\nTest results do not count toward this task's outcome until a person accepts the change.`,
  };
}

/** Returns what happened, for logs and tests. Never throws on the I/O; a failed read leaves the flag as it was. */
export async function syncAcceptanceEdit(
  input: { prNumber: number; headSha: string },
  deps: AcceptanceEditDeps,
): Promise<'not_building' | 'unchanged' | 'cleared' | 'flagged' | 'read_failed'> {
  const task = await deps.taskOfPr();
  if (!task || !isBuildingRole(task.roleSlug)) return 'not_building';
  let files: string[];
  try { files = await deps.changedFiles(); } catch { return 'read_failed'; }
  const prev = acceptanceEditOf(task.context);
  const next = flagAcceptanceEdit(prev, acceptanceTestPaths(files), input.headSha, (deps.now ?? (() => new Date().toISOString()))());
  if (!next) {
    if (!prev) return 'unchanged';
    await deps.saveFlag(task.id, null);
    return 'cleared';
  }
  await deps.saveFlag(task.id, next);
  const before = new Set(pendingAcceptance(prev));
  const fresh = pendingAcceptance(next).filter((p) => !before.has(p));
  if (!fresh.length) return 'unchanged';
  const { title, body } = flagText(fresh, input.prNumber);
  if (task.missionId) await deps.missionNote(task.missionId, task.id, title, body).catch(() => {});
  await deps.prComment(body).catch(() => {});
  return 'flagged';
}
