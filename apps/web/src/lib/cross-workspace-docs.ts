/**
 * Database side of cross-workspace docs retrieval
 * (packages/core/cross-workspace-docs.ts, docs/design/cross-workspace-retrieval.md).
 *
 * `loadReadableDocsWorkspaces` answers, for one MCP call, which other
 * workspaces' docs it may also search. It is injected into the knowledge tools
 * as `resolveCrossWorkspaceDocs`; every failure is an empty answer.
 * The write-side check lives in cross-workspace-docs-input.ts, which the admin
 * config routes import without this file's wider query surface.
 */

import { db } from '@buildd/core/db';
import { workspaces, workers, tasks } from '@buildd/core/db/schema';
import {
  effectiveDataClass,
  normalizeCrossWorkspaceDocs,
  resolveReadableWorkspaces,
  type ReadableWorkspace,
} from '@buildd/core/cross-workspace-docs';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Whether the worker's context includes attacker-influenced input. A reviewer
 * reads a contributor's diff and writes PR comments, so it gets no wider corpus.
 * A worker whose task cannot be resolved is untrusted: this is a deny switch,
 * and the unknown case must not be the permissive one.
 */
async function holdsUntrustedInput(workerId: string): Promise<boolean> {
  try {
    const worker = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { taskId: true },
    });
    if (!worker?.taskId) return true;
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, worker.taskId),
      columns: { category: true, roleSlug: true },
    });
    if (!task) return true;
    return task.category === 'review' || task.roleSlug === 'reviewer';
  } catch {
    return true;
  }
}

export async function loadReadableDocsWorkspaces(input: {
  workspaceId: string | null | undefined;
  /** The caller's team; the reader workspace must belong to it. */
  teamId?: string;
  workerId?: string;
}): Promise<ReadableWorkspace[]> {
  if (!input.workspaceId) return [];
  try {
    const reader = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, input.workspaceId),
      columns: { id: true, teamId: true, dataClass: true, gitConfig: true },
    });
    if (!reader) return [];
    if (input.teamId && reader.teamId !== input.teamId) return [];

    const config = normalizeCrossWorkspaceDocs(reader.gitConfig?.crossWorkspaceDocs);
    if (!config || config.sources.length === 0) return [];

    const untrustedInput = input.workerId ? await holdsUntrustedInput(input.workerId) : false;
    if (untrustedInput) return [];

    const rows = await db.query.workspaces.findMany({
      where: and(
        eq(workspaces.teamId, reader.teamId),
        inArray(workspaces.id, config.sources.map((s) => s.workspaceId)),
      ),
      columns: { id: true, name: true, teamId: true, dataClass: true, gitConfig: true },
    });

    return resolveReadableWorkspaces({
      readerWorkspaceId: reader.id,
      readerDataClass: effectiveDataClass(reader.dataClass, reader.gitConfig?.dataClass),
      config,
      // The query already filters by team; the row check keeps the boundary
      // here too, not only in a WHERE clause.
      teamWorkspaces: rows
        .filter((r) => r.teamId === reader.teamId)
        .map((r) => ({
          id: r.id,
          name: r.name,
          dataClass: effectiveDataClass(r.dataClass, r.gitConfig?.dataClass),
        })),
    });
  } catch {
    return [];
  }
}
