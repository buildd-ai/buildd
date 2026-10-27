import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';

/**
 * The specs a revision replaces ("Retiring a spec" R-76, R-77): ids stored on
 * the revision as data (`spec_revisions.replaces`), never read from the body.
 * An agent may name them; only a person's approval supersedes them, each the
 * person leaves checked.
 */

/** At most this many specs one revision replaces. */
export const MAX_REPLACES = 20;

const RETIRED: Array<'retired' | 'superseded'> = ['retired', 'superseded'];

/**
 * `replaces` from a request: undefined when absent, null when cleared (null or
 * []), else the ids, de-duplicated in order. `supersedes` (create_draft's
 * duplicate override) names one more. Pure.
 */
export function parseReplaces(raw: unknown, supersedes?: string): string[] | null | undefined | { error: string } {
  if (raw === undefined && !supersedes) return undefined;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) return { error: 'replaces must be a list of spec ids' };
  const ids = [...((raw as unknown[] | null | undefined) ?? []), ...(supersedes ? [supersedes] : [])];
  for (const id of ids) if (typeof id !== 'string' || !isUuid(id)) return { error: 'replaces must be a list of spec ids' };
  const out = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  if (out.length > MAX_REPLACES) return { error: `replaces names at most ${MAX_REPLACES} specs` };
  return out.length ? out : null;
}

/** Why one replaced spec may not be replaced (null = it may). `target` is null when no such spec was read. Pure. */
export function replacedSpecProblem(
  self: { id: string; workspaceId: string },
  target: { id: string; workspaceId: string; status: string } | null,
  id: string | undefined = target?.id,
): string | null {
  if (!target || target.workspaceId !== self.workspaceId) return `replaces names no spec in this workspace (${id})`;
  if ((RETIRED as string[]).includes(target.status)) return `replaces names a spec that is ${target.status} already (${id}): name a live spec`;
  return null;
}

/**
 * Every replaced spec must be live, in this workspace, and not the spec
 * itself; else the reason, for a 400 (nothing written).
 */
export async function replacesRefusal(workspaceId: string, ids: readonly string[], selfId?: string): Promise<string | null> {
  if (selfId && ids.includes(selfId)) return 'replaces names this spec itself';
  const rows = await db.select({ id: specs.id, workspaceId: specs.workspaceId, status: specs.status }).from(specs).where(inArray(specs.id, [...ids]));
  for (const id of ids) {
    const problem = replacedSpecProblem({ id: selfId ?? '', workspaceId }, rows.find((x) => x.id === id) ?? null, id);
    if (problem) return problem;
  }
  return null;
}

/** A replaced spec as an approval shows it: its id, title and the version read, for the retire's CAS. */
export interface ReplacedSpec { id: string; title: string; version: number }

/** The live specs among `ids`, in that order, with their title and version. */
export async function liveReplaced(workspaceId: string, ids: readonly string[] | null | undefined): Promise<ReplacedSpec[]> {
  if (!ids?.length) return [];
  const rows = await db.select({ id: specs.id, title: specs.title, version: specs.version }).from(specs)
    .where(and(inArray(specs.id, [...ids]), eq(specs.workspaceId, workspaceId), notInArray(specs.status, RETIRED)));
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is ReplacedSpec => !!r);
}

/**
 * On a live spec's page, two un-run reads for the page's one read round
 * (lib/read-round.ts), so they cost no round trip of their own:
 * - the live specs its head revision names in `replaces` ("Replaces <spec>", R-100);
 * - the specs whose unapproved head names it ("A replacement is waiting: <spec>", R-76).
 */
export function replacesOfHeadQuery(spec: { id: string; workspaceId: string; headRevision: number }) {
  return db.select({ id: specs.id, title: specs.title }).from(specs)
    .innerJoin(specRevisions, and(
      eq(specRevisions.specId, spec.id), eq(specRevisions.revision, spec.headRevision),
      sql`${specRevisions.replaces} @> jsonb_build_array(${specs.id}::text)`,
    ))
    .where(and(eq(specs.workspaceId, spec.workspaceId), notInArray(specs.status, RETIRED)))
    .orderBy(specs.title).limit(MAX_REPLACES);
}
export function waitingReplacementsQuery(spec: { id: string; workspaceId: string }) {
  return db.select({ id: specs.id, title: specs.title }).from(specs)
    .innerJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, specs.headRevision)))
    .where(and(
      eq(specs.workspaceId, spec.workspaceId),
      notInArray(specs.status, RETIRED),
      isNull(specRevisions.approvedAt),
      sql`${specRevisions.replaces} @> ${JSON.stringify([spec.id])}::jsonb`,
    ))
    .orderBy(specs.title).limit(5);
}

/** Which of a retire choice's specs the revision replaces; anything else is a 400. Pure. */
export type RetireChoice = Array<{ specId: string; expectedVersion?: number }>;
export function parseRetireChoice(raw: unknown, replaces: readonly string[]): RetireChoice | { error: string } {
  if (!Array.isArray(raw)) return { error: 'retire must be a list of the replaced specs to retire' };
  const out: RetireChoice = [];
  for (const item of raw) {
    const specId = typeof item === 'string' ? item : (item as { specId?: unknown } | null)?.specId;
    const v = typeof item === 'object' && item ? (item as { expectedVersion?: unknown }).expectedVersion : undefined;
    if (typeof specId !== 'string' || !isUuid(specId)) return { error: 'retire must be a list of spec ids (or { specId, expectedVersion })' };
    if (v !== undefined && !Number.isInteger(v)) return { error: 'retire: expectedVersion must be the version you read' };
    const id = specId.toLowerCase();
    if (!replaces.includes(id)) return { error: `retire names a spec this revision does not replace (${id})` };
    if (!out.some((x) => x.specId === id)) out.push({ specId: id, ...(v !== undefined ? { expectedVersion: v as number } : {}) });
  }
  return out;
}

/** The default retire choice: every live replaced spec, at the version read. Pure. */
export function defaultRetireChoice(live: readonly ReplacedSpec[]): RetireChoice {
  return live.map((r) => ({ specId: r.id, expectedVersion: r.version }));
}

/** The change row's reason for a spec an approval supersedes. Pure. */
export function approvalRetireReason(replacement: { title: string; revision: number }): string {
  return `Replaced by "${replacement.title}", approved at revision ${replacement.revision}.`.slice(0, 500);
}
