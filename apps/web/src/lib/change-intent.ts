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
import { and, eq, isNull, inArray, ne } from 'drizzle-orm';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

// ── Surface matching ─────────────────────────────────────────────────────────

/**
 * Returns true if `path` is matched by a conflictSurface pattern.
 * Rules (evaluated in order):
 *  1. Exact match.
 *  2. Prefix directory match: pattern "a/b" matches path "a/b/c.ts".
 *  3. Trailing-glob match: pattern "a/b/**" matches any path under "a/b/".
 */
export function matchesSurface(path: string, pattern: string): boolean {
  // Strip trailing "/**" for glob prefix matching
  const globSuffix = '/**';
  const prefix = pattern.endsWith(globSuffix)
    ? pattern.slice(0, -globSuffix.length)
    : null;

  if (prefix !== null) {
    return path === prefix || path.startsWith(prefix + '/');
  }
  // Exact match or prefix-directory match (pattern is a directory)
  return path === pattern || path.startsWith(pattern + '/');
}

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
  for (const ns of namespaces) {
    const dir = ns.dir.replace(/\/+$/, '');
    const overlaps = pathManifest.some(
      (p) => p === dir || p.startsWith(dir + '/'),
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

  // ON CONFLICT DO NOTHING — safe to call multiple times for the same PR (dedup retries)
  try {
    await db.insert(changeIntents).values(rows).onConflictDoNothing();
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
    where: and(
      eq(changeIntents.workspaceId, workspaceId),
      inArray(changeIntents.surface, matchedSurfaces),
      isNull(changeIntents.closedAt),
      ...(excludeTaskId ? [ne(changeIntents.taskId as any, excludeTaskId)] : []),
    ),
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
): Promise<void> {
  try {
    // Resolve missionId so the note appears on the mission timeline too
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { missionId: true },
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
