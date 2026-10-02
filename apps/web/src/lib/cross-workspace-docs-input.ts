/**
 * Write-side check for the `crossWorkspaceDocs` workspace setting
 * (packages/core/cross-workspace-docs.ts). The admin config routes run it
 * before storing the value; the read side is cross-workspace-docs.ts.
 */

import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import {
  MAX_CROSS_WORKSPACE_SOURCES,
  type CrossWorkspaceDocsConfig,
} from '@buildd/core/cross-workspace-docs';
import { eq } from 'drizzle-orm';

export type ValidatedCrossWorkspaceDocs =
  | { ok: true; value: CrossWorkspaceDocsConfig | undefined }
  | { ok: false; error: string };

/**
 * Check an admin's `crossWorkspaceDocs` input. `null` clears the setting
 * (`value: undefined`). A source that is missing and one in another team get the
 * same message, so the check does not confirm that a foreign id exists.
 */
export async function validateCrossWorkspaceDocsInput(
  raw: unknown,
  workspace: { id: string; teamId: string },
): Promise<ValidatedCrossWorkspaceDocs> {
  if (raw === null) return { ok: true, value: undefined };
  const shape = 'crossWorkspaceDocs must be null or { sources: [{ workspaceId, acknowledgeSensitive? }] }';
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: shape };
  const list = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(list)) return { ok: false, error: shape };
  if (list.length > MAX_CROSS_WORKSPACE_SOURCES) {
    return { ok: false, error: `crossWorkspaceDocs lists at most ${MAX_CROSS_WORKSPACE_SOURCES} sources` };
  }

  const seen = new Set<string>();
  const sources: CrossWorkspaceDocsConfig['sources'] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: shape };
    const { workspaceId, acknowledgeSensitive, ...rest } = entry as Record<string, unknown>;
    if (typeof workspaceId !== 'string' || workspaceId === '' || Object.keys(rest).length > 0) {
      return { ok: false, error: shape };
    }
    if (acknowledgeSensitive !== undefined && typeof acknowledgeSensitive !== 'boolean') {
      return { ok: false, error: 'crossWorkspaceDocs acknowledgeSensitive must be a boolean' };
    }
    if (workspaceId === workspace.id) {
      return { ok: false, error: 'crossWorkspaceDocs cannot list the workspace itself' };
    }
    if (seen.has(workspaceId)) {
      return { ok: false, error: 'crossWorkspaceDocs lists a workspace twice' };
    }
    seen.add(workspaceId);

    const source = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (!source || source.teamId !== workspace.teamId) {
      return { ok: false, error: 'crossWorkspaceDocs sources must be workspaces of the same team' };
    }
    sources.push(acknowledgeSensitive === true ? { workspaceId, acknowledgeSensitive: true } : { workspaceId });
  }
  return { ok: true, value: { sources } };
}
