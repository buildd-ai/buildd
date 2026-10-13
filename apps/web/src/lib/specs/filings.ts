import { db } from '@buildd/core/db';
import { specFilings, specs } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * Filings (Living Specs §17, R-3, R-7, R-11): the record of where a spec was
 * placed in its tree and by whom. Structure, not body: setting a parent never
 * moves the version, and every filing buildd makes can be undone.
 *
 * Core. The ledger half of an override (R-11) is the decisions module's,
 * reached through the `SPEC_AREA_OVERRIDE` slot in modules.ts.
 */

export type FilingRow = typeof specFilings.$inferSelect;

/** What the spec page and list say about a spec's placement. */
export interface FilingView {
  id: string;
  kind: 'filed' | 'suggested';
  status: FilingRow['status'];
  parent: { specId: string; title: string } | null;
  previousParent: { specId: string; title: string } | null;
  /** `model` | `similarity` | `taxonomy`. */
  source: string;
  p: number | null;
  /** A proposed new area, for a `new_area` suggestion. */
  newArea: { title: string; charter: string } | null;
  createdAt: Date;
}

/**
 * Set a spec's parent only while it has none, and only to a spec in its own
 * workspace that is not the spec or one of its descendants (one statement, so
 * a person's move in between always wins). Returns whether it was set.
 */
export async function setParentIfUnfiled(workspaceId: string, specId: string, parentSpecId: string): Promise<boolean> {
  if (specId === parentSpecId) return false;
  const rows = await db.execute(sql`
    WITH RECURSIVE ancestors(id, depth) AS (
      SELECT ${parentSpecId}::uuid, 0
      UNION ALL
      SELECT s.parent_spec_id, a.depth + 1 FROM specs s JOIN ancestors a ON s.id = a.id
      WHERE s.parent_spec_id IS NOT NULL AND a.depth < 1000
    )
    UPDATE specs SET parent_spec_id = ${parentSpecId}::uuid, updated_at = now()
    WHERE id = ${specId}::uuid AND workspace_id = ${workspaceId}::uuid AND parent_spec_id IS NULL
      AND EXISTS (SELECT 1 FROM specs p WHERE p.id = ${parentSpecId}::uuid AND p.workspace_id = ${workspaceId}::uuid)
      AND NOT EXISTS (SELECT 1 FROM ancestors WHERE id = ${specId}::uuid)
    RETURNING id`);
  return ((rows as { rows?: unknown[] }).rows ?? []).length > 0;
}

export async function insertFiling(row: typeof specFilings.$inferInsert): Promise<FilingRow> {
  const [r] = await db.insert(specFilings).values(row).returning();
  return r!;
}

/** Specs (of these) with any filing row at all: the sweep leaves them alone (R-10). */
export async function specsWithFilings(specIds: readonly string[]): Promise<Set<string>> {
  if (specIds.length === 0) return new Set();
  const rows = await db.select({ specId: specFilings.specId }).from(specFilings).where(inArray(specFilings.specId, [...specIds]));
  return new Set(rows.map((r) => r.specId));
}

/**
 * Record a placement made by hand (R-11): a `manual` row, so no run moves the
 * spec again; buildd's live filing becomes `overridden` and the person's
 * choice is written on its ledger row; an open suggestion is accepted when
 * the new parent is the one it offered, else dismissed. Never throws.
 */
export async function recordManualPlacement(input: { workspaceId: string; specId: string; previousParentId: string | null; parentSpecId: string | null; by: string }): Promise<void> {
  try {
    const now = new Date();
    const open = await db.select().from(specFilings)
      .where(and(eq(specFilings.specId, input.specId), inArray(specFilings.status, ['applied', 'open']), inArray(specFilings.kind, ['filed', 'suggested'])));
    for (const f of open) {
      if (f.kind === 'filed') {
        await db.update(specFilings).set({ status: 'overridden', resolvedAt: now, resolvedBy: input.by }).where(eq(specFilings.id, f.id));
        if (f.decisionRecordId) {
          const { SPEC_AREA_OVERRIDE } = await import('@/modules');
          await SPEC_AREA_OVERRIDE(f.decisionRecordId, { parentSpecId: input.parentSpecId, previousParentId: f.parentSpecId }, input.by);
        }
      } else {
        const status = input.parentSpecId && f.parentSpecId === input.parentSpecId ? 'accepted' : 'dismissed';
        await db.update(specFilings).set({ status, resolvedAt: now, resolvedBy: input.by }).where(eq(specFilings.id, f.id));
      }
    }
    await insertFiling({
      workspaceId: input.workspaceId, specId: input.specId, kind: 'manual', status: 'applied', source: 'person',
      previousParentId: input.previousParentId, parentSpecId: input.parentSpecId, createdBy: input.by,
    });
  } catch (err) {
    console.warn('[living-specs] manual placement not recorded (the move stands):', (err as Error)?.message ?? err);
  }
}

/** The newest filed or suggested placement still in effect for a spec, for its page. */
export async function currentFiling(specId: string): Promise<FilingView | null> {
  const [f] = await db.select().from(specFilings)
    .where(and(eq(specFilings.specId, specId), inArray(specFilings.kind, ['filed', 'suggested']), inArray(specFilings.status, ['applied', 'open'])))
    .orderBy(desc(specFilings.createdAt)).limit(1);
  if (!f) return null;
  return (await filingViews([f]))[0] ?? null;
}

export async function filingViews(rows: readonly FilingRow[]): Promise<FilingView[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.parentSpecId, r.previousParentId]).filter((x): x is string => !!x))];
  const titled = ids.length ? await db.select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId }).from(specs).where(inArray(specs.id, ids)) : [];
  return rows.map((f) => {
    const name = (id: string | null) => {
      const t = id ? titled.find((x) => x.id === id && x.workspaceId === f.workspaceId) : undefined;
      return t ? { specId: t.id, title: t.title } : null;
    };
    const prop = (f.proposal ?? {}) as Record<string, unknown>;
    const newArea = prop.answer === 'new_area' && typeof prop.title === 'string' ? { title: prop.title, charter: typeof prop.charter === 'string' ? prop.charter : '' } : null;
    return {
      id: f.id, kind: f.kind as 'filed' | 'suggested', status: f.status, parent: name(f.parentSpecId), previousParent: name(f.previousParentId),
      source: f.source, p: typeof prop.p === 'number' ? prop.p : null, newArea, createdAt: f.createdAt,
    };
  });
}
