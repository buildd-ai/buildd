import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { designDrift, parseDesignRef } from '@buildd/spec-contract/design';
import type { DesignRef } from '@buildd/spec-contract/shapes';
import { fail, type SpecError } from './store';

/**
 * A spec revision's design (Living Specs D-8/D-9, §12). The default design is
 * an artifact in the same workspace (an HTML or code prototype, or images),
 * pinned to one artifact revision; a URL or a design-tool file names its own
 * version. Stored on the revision, so approving the revision records the
 * design version next to the text (D-9).
 */
export type StoredDesign = DesignRef & { version: string };

/**
 * A request's `design`: undefined when absent, null when cleared, else the
 * checked reference. An artifact must be in the workspace; with no version it
 * is pinned to its current revision, and a named revision must exist.
 */
export async function resolveDesign(workspaceId: string, raw: unknown): Promise<StoredDesign | null | undefined | SpecError> {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const parsed = parseDesignRef(raw);
  if (!parsed.ok) return fail(400, parsed.error);
  const d = parsed.design;
  if (d.kind !== 'artifact') return d as StoredDesign;
  if (!isUuid(d.ref)) return fail(400, 'design.ref must be an artifact id for kind artifact');
  const [art] = await db.select({ workspaceId: artifacts.workspaceId, currentRevision: artifacts.currentRevision })
    .from(artifacts).where(eq(artifacts.id, d.ref)).limit(1);
  if (!art || art.workspaceId !== workspaceId) return fail(400, 'design.ref names no artifact in this workspace; nothing was written');
  const version = d.version ?? String(art.currentRevision);
  if (Number(version) < 1 || !(await getArtifactRevision(d.ref, Number(version)))) {
    return fail(400, `design artifact has no revision ${version}; nothing was written`);
  }
  return { ...d, version };
}

/** The design's version now, when buildd can read it (an artifact); else null. */
export async function currentDesignVersion(design: DesignRef | null | undefined): Promise<string | null> {
  if (!design || design.kind !== 'artifact' || !isUuid(design.ref)) return null;
  const [art] = await db.select({ currentRevision: artifacts.currentRevision }).from(artifacts).where(eq(artifacts.id, design.ref)).limit(1);
  return art ? String(art.currentRevision) : null;
}

/** "Design changed since approval": the approved revision's design has a newer version. */
export async function approvedDesignDrift(design: DesignRef | null | undefined): Promise<{ pinned: string; current: string } | null> {
  return designDrift(design, await currentDesignVersion(design));
}
