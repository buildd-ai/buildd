/**
 * Change-intent helpers — surface-conflict detection, intent recording, and lifecycle.
 *
 * See docs/design/change-intent.md for the full design.
 *
 * Core contract:
 *  - recordIntentsForPr():  called at create_pr time; inserts intent rows + posts warnings.
 *  - closeIntentsForPr():   called in GitHub webhook when PR closes/merges.
 *  - matchesSurface():      pure function, tested in isolation.
 */

import { db } from '@buildd/core/db';
import { changeIntents, missionNotes, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, isNull, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { fireGateEvent, GATE_SLUGS } from './gate-ledger';

// ── Surface matching ─────────────────────────────────────────────────────────

export { matchesSurface } from './surface-ordering-config';
import { matchesSurface } from './surface-ordering-config';

/**
 * Given a list of file paths and the workspace gitConfig, returns the surfaces
 * (labels) that the paths touch.
 */
export function resolveMatchedSurfaces(
  paths: string[],
  gitConfig: WorkspaceGitConfig | null | undefined,
): string[] {
  const surfaces = gitConfig?.conflictSurfaces;
  if (!surfaces?.length || !paths.length) return [];

  const matched = new Set<string>();
  for (const surface of surfaces) {
    for (const path of paths) {
      if (matchesSurface(path, surface.pattern)) {
        matched.add(surface.label);
        break;
      }
    }
  }
  return [...matched];
}

// ── Sequence-namespace anchor injection ──────────────────────────────────────

/**
 * Given a task's pathManifest and the workspace gitConfig, returns additional
 * anchor files that should be auto-appended to the manifest.
 *
 * Drizzle migrations example: any path under "packages/core/drizzle" triggers
 * auto-append of "packages/core/drizzle/meta/_journal.json" so the claim-route
 * serialisation (findBlockingPr) fires on the anchor file rather than individual
 * migration filenames (which have distinct names despite sharing the integer index).
 */
export function resolveAnchorInjections(
  pathManifest: string[],
  gitConfig: WorkspaceGitConfig | null | undefined,
): string[] {
  const namespaces = gitConfig?.sequenceNamespaces;
  if (!namespaces?.length || !pathManifest.length) return [];

  const toAdd: string[] = [];
  const under = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');
  for (const ns of namespaces) {
    const dir = ns.dir.replace(/\/+$/, '');
    // A schema trigger (e.g. schema.ts) generates INTO the namespace without
    // touching it: a manifest naming the trigger, or a directory containing
    // it, serializes on the anchor too. The directory-only rule misses it.
    const triggers = (ns.triggers ?? []).map((t) => t.replace(/\/+$/, ''));
    const overlaps = pathManifest.some(
      (p) => under(p, dir) || triggers.some((t) => under(t, p.replace(/\/+$/, ''))),
    );
    if (overlaps && !pathManifest.includes(ns.anchorFile)) {
      toAdd.push(ns.anchorFile);
    }
  }
  return toAdd;
}

// ── Intent recording ─────────────────────────────────────────────────────────

interface RecordIntentsInput {
  workspaceId: string;
  taskId: string | null | undefined;
  prNumber: number;
  branch: string;
  headSha?: string | null;
  matchedSurfaces: string[];
}

/**
 * Insert changeIntent rows for each surface (idempotent — skips if already open
 * for this task+surface combination).
 */
export async function recordChangeIntents(input: RecordIntentsInput): Promise<void> {
  const { workspaceId, taskId, prNumber, branch, headSha, matchedSurfaces } = input;
  if (!matchedSurfaces.length) return;

  const rows = matchedSurfaces.map((surface) => ({
    workspaceId,
    surface,
    taskId: taskId ?? null,
    prNumber,
    branch,
    headSha: headSha ?? null,
  }));

  // One open row per (workspace, PR, surface). The table has no unique key for
  // ON CONFLICT DO NOTHING to bind to, so each insert is guarded by NOT EXISTS
  // in the same statement; a racing duplicate is harmless (ordering groups
  // contenders per PR).
  try {
    for (const row of rows) {
      await db.execute(intentInsertIfAbsentSql({ ...row, branch: row.branch ?? null, headSha: row.headSha }));
    }
  } catch (err) {
    console.error('[changeIntent] Failed to record intent rows:', err);
  }
}

// ── Warning notes ────────────────────────────────────────────────────────────

interface ConflictingIntent {
  taskId: string | null;
  prNumber: number | null;
  surface: string;
}

/**
 * Open intents on these surfaces, minus one task's own. `task_id <> x` is NULL
 * (not true) for a row whose task was deleted or never set, so a bare `ne`
 * would silently drop every task-less PR from the conflict set.
 */
export function conflictingIntentsWhere(
  workspaceId: string,
  surfaces: string[],
  excludeTaskId: string | null | undefined,
): SQL {
  return and(
    eq(changeIntents.workspaceId, workspaceId),
    inArray(changeIntents.surface, surfaces),
    isNull(changeIntents.closedAt),
    ...(excludeTaskId ? [or(isNull(changeIntents.taskId), ne(changeIntents.taskId, excludeTaskId))!] : []),
  )!;
}

/**
 * One open intent per (workspace, PR, surface), as one statement guarded by
 * NOT EXISTS (see recordChangeIntents).
 */
export function intentInsertIfAbsentSql(i: {
  workspaceId: string; surface: string; taskId: string | null; prNumber: number; branch: string | null; headSha: string | null;
}): SQL {
  return sql`INSERT INTO "change_intents" ("workspace_id", "surface", "task_id", "pr_number", "branch", "head_sha")
    SELECT ${i.workspaceId}::uuid, ${i.surface}, ${i.taskId}::uuid, ${i.prNumber}::int, ${i.branch}, ${i.headSha}
    WHERE NOT EXISTS (
      SELECT 1 FROM "change_intents" ci
      WHERE ci.workspace_id = ${i.workspaceId}::uuid AND ci.pr_number = ${i.prNumber}::int
        AND ci.surface = ${i.surface} AND ci.closed_at IS NULL
    )`;
}

/**
 * Find open changeIntent rows for the same workspace + surfaces (excluding the
 * current task so we don't warn a task about itself).
 */
export async function findConflictingIntents(
  workspaceId: string,
  matchedSurfaces: string[],
  excludeTaskId: string | null | undefined,
): Promise<ConflictingIntent[]> {
  if (!matchedSurfaces.length) return [];

  const rows = await db.query.changeIntents.findMany({
    where: conflictingIntentsWhere(workspaceId, matchedSurfaces, excludeTaskId),
    columns: { taskId: true, prNumber: true, surface: true },
  });

  return rows as ConflictingIntent[];
}

/**
 * Post a warning note on a task (scoped to the task — no missionId required).
 * Non-fatal: any DB error is swallowed so PR creation never fails due to a
 * missing note.
 */
async function postConflictNote(
  taskId: string,
  title: string,
  body: string,
  detail: { surfaces: string[]; currentPrNumber: number; conflictingPrNumber: number | null },
): Promise<void> {
  try {
    // Resolve missionId so the note appears on the mission timeline too
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { missionId: true, workspaceId: true },
    });

    await db.insert(missionNotes).values({
      taskId,
      missionId: task?.missionId ?? null,
      authorType: 'system',
      type: 'warning',
      title,
      body,
      status: 'open',
    });
    // Count delivered warning notes, including both tasks in the conflict.
    fireGateEvent({
      gate: GATE_SLUGS.CHANGE_INTENT,
      surface: 'create_pr',
      outcome: 'warned',
      reason: 'Change intent conflict surface overlap',
      workspaceId: task?.workspaceId ?? null,
      missionId: task?.missionId ?? null,
      taskId,
      callerOrigin: 'system',
      // Advisory: a warning note never gates a merge. Ordering deferrals are
      // the separate `surface_ordering` gate (lib/surface-ordering.ts).
      detail: { ...detail, advisory: true },
    });
  } catch (err) {
    console.error('[changeIntent] Failed to post conflict note on task', taskId, ':', err);
  }
}

/**
 * Post warning notes on the current task AND each conflicting counterpart task.
 * Called after a PR is created and intent rows are recorded.
 */
export async function postConflictWarnings(params: {
  currentTaskId: string | null | undefined;
  currentPrNumber: number;
  currentPrUrl: string | null | undefined;
  currentSurfaces: string[];
  conflicting: ConflictingIntent[];
}): Promise<void> {
  const { currentTaskId, currentPrNumber, currentPrUrl, currentSurfaces, conflicting } = params;
  if (!conflicting.length || !currentSurfaces.length) return;

  // Build per-surface counterpart map
  const counterpartsByTaskId = new Map<string, { surfaces: string[]; prNumber: number | null }>();
  for (const c of conflicting) {
    if (!c.taskId) continue;
    const existing = counterpartsByTaskId.get(c.taskId) ?? { surfaces: [], prNumber: c.prNumber };
    existing.surfaces.push(c.surface);
    counterpartsByTaskId.set(c.taskId, existing);
  }

  for (const [counterTaskId, { surfaces, prNumber }] of counterpartsByTaskId) {
    const surfaceList = surfaces.join(', ');
    const counterPrRef = prNumber ? `PR #${prNumber}` : 'another open PR';
    const currentPrRef = `PR #${currentPrNumber}${currentPrUrl ? ` (${currentPrUrl})` : ''}`;

    // Warn the current task
    if (currentTaskId) {
      await postConflictNote(
        currentTaskId,
        `⚠ Conflict surface overlap: ${surfaceList}`,
        `This PR (${currentPrRef}) and ${counterPrRef} both touch **${surfaceList}**.\n\n` +
          `To avoid a merge conflict, coordinate with the other PR before pushing. ` +
          `For Drizzle migrations: rebase your branch onto the other PR's branch ` +
          `(or renumber your migration file) before opening a follow-up PR.`,
        { surfaces, currentPrNumber, conflictingPrNumber: prNumber },
      );
    }

    // Warn the counterpart task
    await postConflictNote(
      counterTaskId,
      `⚠ Conflict surface overlap: ${surfaceList}`,
      `${currentPrRef} also touches **${surfaceList}**, same as this task's ${counterPrRef}.\n\n` +
        `To avoid a merge conflict, land one PR before the other, or coordinate ` +
        `which branch should be rebased. For Drizzle migrations: the later branch ` +
        `should rebase onto the earlier one.`,
      { surfaces, currentPrNumber, conflictingPrNumber: prNumber },
    );
  }
}

// ── Intent lifecycle ─────────────────────────────────────────────────────────

/**
 * Mark all open changeIntent rows for the given PR number (workspace-scoped) as closed.
 * Called from the GitHub webhook when a PR is merged or abandoned.
 */
export async function closeIntentsForPr(
  workspaceId: string,
  prNumber: number,
): Promise<void> {
  try {
    await db
      .update(changeIntents)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(changeIntents.workspaceId, workspaceId),
          eq(changeIntents.prNumber as any, prNumber),
          isNull(changeIntents.closedAt),
        ),
      );
  } catch (err) {
    console.error('[changeIntent] Failed to close intents for PR', prNumber, ':', err);
  }
}
