import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import type { SpecApprovalRecord, SpecApprovedAttachment, SpecAutoApprovalEvidence } from '@buildd/core/db/schema';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { NO_CRITERIA_CHANGE_CHECK, noCriteriaChange, type BindingPin } from '@buildd/spec-contract/no-criteria-change';
import { getArtifactRevisions } from '@/lib/artifact-revisions';
import { approvedAttachmentsSql } from './attachment-pins';
import { awaitingApprovalWhere } from './approval-inbox';
import { diffSpecBodies } from './diff';

/**
 * Automatic approval of a revision that changes no criterion (Living Spec
 * b7fc9316 R-21 to R-23, R-27).
 *
 * A person approved every criterion and design binding of the approved
 * revision. When the new head holds exactly the same ones, compared as text
 * (packages/spec-contract no-criteria-change.ts), the head stands approved
 * without asking them again, stamped `check:no-criteria-change` with the
 * evidence: never a person's name, never a person's approval.
 *
 * It runs on the server when a revision is written (store.ts reviseSpecDraft)
 * and in the maintenance sweep over what already waits (sweepNoCriteriaChange).
 * Nothing a caller sends starts, skips or widens it: it takes a spec id and
 * reads everything else from the store. It calls no model and no network.
 * Any doubt leaves the revision to a person: no approved revision, a retired
 * or imported spec, a changed `replaces`, a body that fails its hash, a parse
 * doubt, or a quality gate refusal.
 */

export type AutoApproval =
  | { approved: true; revision: number; evidence: SpecAutoApprovalEvidence }
  | { approved: false; reason: string };

const no = (reason: string): AutoApproval => ({ approved: false, reason });
const rowsOf = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? []);
const pinsOf = (v: readonly SpecApprovedAttachment[] | null | undefined): BindingPin[] => (v ?? []).map((p) => ({ name: p.name, artifactId: p.artifactId, revision: p.revision }));

/** Run the check on the spec's head; stamp it approved when nothing a person approved changed. */
export async function autoApproveNoCriteriaChange(specId: string): Promise<AutoApproval> {
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return no('spec not found');
  if (spec.status === 'retired' || spec.status === 'superseded') return no(`the spec is ${spec.status}`);
  if (spec.repoSource?.state === 'imported') return no('an import waits for a person to confirm it');
  const approvedN = spec.approvedRevision;
  const n = spec.headRevision;
  if (approvedN == null) return no('nothing is approved yet, so there is nothing to compare with');
  if (approvedN >= n) return no('the head is already approved');

  const revs = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), inArray(specRevisions.revision, [approvedN, n])));
  const from = revs.find((r) => r.revision === approvedN);
  const to = revs.find((r) => r.revision === n);
  if (!from || !to || !from.approvedAt) return no('a revision is missing');
  if (JSON.stringify(from.replaces ?? []) !== JSON.stringify(to.replaces ?? [])) return no('the specs it replaces changed');

  const read = await getArtifactRevisions(spec.bodyArtifactId, [from.artifactRevision, to.artifactRevision]);
  const body = (r: typeof from) => {
    const a = read.get(r.artifactRevision);
    return a && typeof a.content === 'string' && a.contentHash === r.contentHash ? a.content : null;
  };
  const fromBody = body(from);
  const toBody = body(to);
  if (fromBody === null || toBody === null) return no('a body is missing or does not match its hash');

  // The head's binding attachments as an approval now would record them, against what the approval did.
  const [{ pins } = { pins: [] }] = rowsOf<{ pins: SpecApprovedAttachment[] }>(await db.execute(sql`SELECT ${approvedAttachmentsSql(specId, n)} AS pins`));
  const result = await noCriteriaChange(
    { body: fromBody, design: from.design ?? null, bindings: pinsOf(from.approvedAttachments) },
    { body: toBody, design: to.design ?? null, bindings: pinsOf(pins) },
  );
  if (!result.unchanged) return no(result.message);

  // R-23: the quality gate first; a refusal waits on a person.
  const { runApprovalGate } = await import('./approval-gate');
  const { gate } = await runApprovalGate(spec, n);
  if (!gate.passed) return no(`the quality gate refuses it: ${gate.refusals.map((r) => r.code).join(', ')}`);

  const changed = diffSpecBodies(fromBody, toBody).sections.reduce((k, s) => k + s.linesAdded + s.linesRemoved, 0);
  const evidence: SpecAutoApprovalEvidence = {
    from: { revision: approvedN, contentHash: from.contentHash, ...result.evidence.from },
    to: { revision: n, contentHash: to.contentHash, ...result.evidence.to },
    criteria: result.evidence.criteria,
    otherChangedLines: changed,
  };
  const record: SpecApprovalRecord = { via: 'check', gate, check: { name: NO_CRITERIA_CHANGE_CHECK, evidence } };

  // The same atomic stamp as a person's approval, pinned to the head, version
  // and body read above: a revise that lands meanwhile changes nothing here.
  const rows = await db.execute(sql`
    WITH stamp AS (
      UPDATE spec_revisions SET approved_by = ${NO_CRITERIA_CHANGE_CHECK}, approved_at = now(), approval = ${JSON.stringify(record)}::jsonb,
        approved_attachments = ${approvedAttachmentsSql(specId, n)}
      WHERE spec_id = ${specId}::uuid AND revision = ${n} AND approved_at IS NULL AND content_hash = ${to.contentHash}
        AND EXISTS (SELECT 1 FROM specs WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND approved_revision = ${approvedN})
      RETURNING revision
    )
    UPDATE specs SET approved_revision = ${n}, status = 'approved', version = version + 1, updated_at = now()
    WHERE id = ${specId}::uuid AND version = ${spec.version} AND head_revision = ${n} AND EXISTS (SELECT 1 FROM stamp)
    RETURNING id`);
  if (rowsOf(rows).length === 0) return no('the spec changed while it was checked');

  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  const { followApproval } = await import('./approval');
  if (after) followApproval(after, n);
  return { approved: true, revision: n, evidence };
}

/** At most this many specs are checked per sweep. */
export const SWEEP_LIMIT = 25;

/**
 * The maintenance sweep: run the check over specs already waiting for
 * approval. A spec whose stored criterion records already differ between the
 * approved revision and the head cannot pass, so it is not read; one whose
 * records are not derived yet is checked (the gate derives them, so it is
 * judged on records from then on). Each spec fails on its own.
 */
export async function sweepNoCriteriaChange(opts: { limit?: number } = {}): Promise<{ checked: number; approved: number; failed: number }> {
  const recs = (rev: SQL) => sql`SELECT criterion_id, position, text_hash, section, checks::text, screens::text, replaces::text FROM spec_criteria c WHERE c.spec_id = specs.id AND c.revision = ${rev}`;
  const candidates = rowsOf<{ id: string }>(await db.execute(sql`
    SELECT specs.id FROM specs
    JOIN spec_revisions h ON h.spec_id = specs.id AND h.revision = specs.head_revision
    JOIN spec_revisions a ON a.spec_id = specs.id AND a.revision = specs.approved_revision
    WHERE ${awaitingApprovalWhere()} AND specs.approved_revision IS NOT NULL
      AND (h.criteria_count IS NULL OR a.criteria_count IS NULL OR (h.criteria_count > 0
        AND NOT EXISTS (${recs(sql`specs.head_revision`)} EXCEPT ${recs(sql`specs.approved_revision`)})
        AND NOT EXISTS (${recs(sql`specs.approved_revision`)} EXCEPT ${recs(sql`specs.head_revision`)})))
    ORDER BY specs.updated_at DESC
    LIMIT ${opts.limit ?? SWEEP_LIMIT}`));
  let approved = 0; let failed = 0;
  for (const c of candidates) {
    try {
      if ((await autoApproveNoCriteriaChange(c.id)).approved) approved++;
    } catch (err) {
      failed++;
      console.error(`[specs] ${NO_CRITERIA_CHANGE_CHECK} on ${c.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { checked: candidates.length, approved, failed };
}
