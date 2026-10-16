import { db } from '@buildd/core/db';
import { specRevisions, specs, type SpecMetadataBlock, type SpecPublicationDecision } from '@buildd/core/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { specShortId } from '@buildd/spec-contract/repo-copy';

/**
 * Which specs leave buildd (docs/specs/living-specs.md, Slice 14). The policy
 * is plain text a person approves (D-21): the Publication section of the
 * workspace's product spec, at its approved revision. That revision is the
 * policy version. Without one nothing is published.
 *
 * This file is the core half: reading the policy, a spec's mark (R-66) and the
 * sentence the spec page shows (R-68). The decision itself is the
 * `buildd.spec_publication` kind (lib/spec-publication-decision.ts), reached
 * through the `SPEC_PUBLICATION_DECIDE` slot in modules.ts.
 */

/** Numbered policy lines the model can name. The kind's `line` question has this many slots. */
export const POLICY_LINE_SLOTS = 16;

export type PolicyLineGroup = 'publish' | 'private' | 'other';
export interface PolicyLine { n: number; group: PolicyLineGroup; text: string }
export interface PublicationPolicy {
  /** The product spec the policy lives in. */
  specId: string;
  revision: number;
  /** `<short id>-r<revision>`: what every decision records (R-69). */
  version: string;
  /** The Publication section, as approved. */
  text: string;
  lines: PolicyLine[];
}

export type PublicationMark = 'private' | 'public';

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

/** What a label line before a list says about it: "May be published:" or "Stays in buildd:". */
function groupOf(label: string): PolicyLineGroup {
  const l = label.toLowerCase();
  if (/\b(stays?|kept|keep|private|never|not|must not|out of)\b/.test(l)) return 'private';
  if (/\b(may|can|allowed|public|publish(ed)?)\b/.test(l)) return 'publish';
  return 'other';
}

/**
 * The Publication section of a product spec's body: its text and its list
 * lines, numbered, each under the label before it. Null when there is none.
 * Pure.
 */
export function parsePublicationSection(body: string): { text: string; lines: PolicyLine[] } | null {
  const rows = body.split('\n');
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < rows.length; i++) {
    if (/^\s*(```|~~~)/.test(rows[i])) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(rows[i]);
    if (h && h[2].toLowerCase() === 'publication') { start = i; level = h[1].length; break; }
  }
  if (start < 0) return null;
  let end = rows.length;
  fence = false;
  for (let i = start + 1; i < rows.length; i++) {
    if (/^\s*(```|~~~)/.test(rows[i])) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(rows[i]);
    if (h && h[1].length <= level) { end = i; break; }
  }
  const section = rows.slice(start, end);
  const lines: PolicyLine[] = [];
  let group: PolicyLineGroup = 'other';
  for (const row of section.slice(1)) {
    const b = BULLET.exec(row);
    if (b) {
      if (lines.length < POLICY_LINE_SLOTS) lines.push({ n: lines.length + 1, group, text: b[1] });
      continue;
    }
    const t = row.trim();
    if (!t) continue;
    const h = HEADING.exec(row);
    const label = h ? h[2] : t;
    if (h || t.endsWith(':')) group = groupOf(label);
  }
  return { text: section.join('\n').trim(), lines };
}

interface Ancestor { id: string; scope: string; metadata: SpecMetadataBlock | null; approved_revision: number | null; body_artifact_id: string; depth: number }

/** The spec and every ancestor, nearest first. */
async function ancestors(specId: string): Promise<Ancestor[]> {
  const res = (await db.execute(sql`
    WITH RECURSIVE up(id, parent_spec_id, scope, metadata, approved_revision, body_artifact_id, depth) AS (
      SELECT s.id, s.parent_spec_id, s.scope, s.metadata, s.approved_revision, s.body_artifact_id, 0 FROM specs s WHERE s.id = ${specId}::uuid
      UNION ALL
      SELECT p.id, p.parent_spec_id, p.scope, p.metadata, p.approved_revision, p.body_artifact_id, up.depth + 1
      FROM specs p JOIN up ON p.id = up.parent_spec_id WHERE up.depth < 50
    )
    SELECT id, scope, metadata, approved_revision, body_artifact_id, depth FROM up ORDER BY depth`)) as unknown as { rows: Array<Ancestor & { metadata: SpecMetadataBlock | string | null }> };
  return res.rows.map((r) => ({ ...r, metadata: typeof r.metadata === 'string' ? (JSON.parse(r.metadata) as SpecMetadataBlock) : r.metadata }));
}

/**
 * R-66: the mark in effect. The spec's own, else its nearest area's. Null:
 * follow the policy.
 */
export async function publicationMark(specId: string): Promise<{ mark: PublicationMark; from: 'spec' | 'area' } | null> {
  const chain = await ancestors(specId);
  const own = chain[0]?.metadata?.publication;
  if (own === 'private' || own === 'public') return { mark: own, from: 'spec' };
  const area = chain.find((a) => a.depth > 0 && a.scope === 'domain');
  const inherited = area?.metadata?.publication;
  return inherited === 'private' || inherited === 'public' ? { mark: inherited, from: 'area' } : null;
}

async function policyOf(product: { id: string; approved_revision: number | null; body_artifact_id: string }): Promise<PublicationPolicy | null> {
  if (product.approved_revision == null) return null;
  const [rev] = await db.select({ artifactRevision: specRevisions.artifactRevision }).from(specRevisions)
    .where(and(eq(specRevisions.specId, product.id), eq(specRevisions.revision, product.approved_revision))).limit(1);
  if (!rev) return null;
  const body = (await getArtifactRevision(product.body_artifact_id, rev.artifactRevision))?.content ?? '';
  const section = parsePublicationSection(body);
  if (!section) return null;
  return { specId: product.id, revision: product.approved_revision, version: `${specShortId(product.id)}-r${product.approved_revision}`, ...section };
}

/**
 * The policy in force for a spec (D-21): the Publication section of its
 * product spec at the approved revision. The product is the spec's nearest
 * product ancestor, else the workspace's one product spec (none when it has
 * several and the spec is under none of them). Null: no policy yet.
 */
export async function readPublicationPolicy(workspaceId: string, specId?: string): Promise<PublicationPolicy | null> {
  if (specId) {
    const product = (await ancestors(specId)).find((a) => a.scope === 'product');
    if (product) return policyOf(product);
  }
  const products = await db.select({ id: specs.id, approved_revision: specs.approvedRevision, body_artifact_id: specs.bodyArtifactId }).from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), eq(specs.scope, 'product'), isNotNull(specs.approvedRevision))).limit(2);
  return products.length === 1 ? policyOf(products[0]) : null;
}

// ── The sentence on the spec page (R-68) ────────────────────────────────────

const quote = (line: string) => `"${line.replace(/\s+/g, ' ').trim().slice(0, 160)}"`;

/**
 * One sentence: why a revision was kept private, naming the rule or the policy
 * line. Pure; stored on the decision so the page shows what was decided then.
 */
export function publicationReason(d: Pick<SpecPublicationDecision, 'publish' | 'reasonCode' | 'line'> & { hit?: string; markFrom?: 'spec' | 'area' }): string {
  if (d.publish) return d.line ? `Published under the policy line ${quote(d.line)}.` : 'Published.';
  const code = d.reasonCode;
  if (code === 'rule_prod_data') return `Not published: the text has what looks like production data${d.hit ? ` (${d.hit})` : ''}. Take it out in a new revision.`;
  if (code === 'rule_no_policy') return 'Not published: this workspace has no publication policy yet. Add a Publication section to the product spec and approve it.';
  if (code === 'rule_marked_private') return d.markFrom === 'area' ? 'Not published: its area is marked private.' : 'Not published: a person marked this spec private.';
  if (code === 'rule_too_long') return 'Not published: the spec is too long to check against the policy in one read, so it stays in buildd unless a person marks it public.';
  if (code.startsWith('model_keep_private')) return d.line ? `Not published: the policy keeps this out of the repo (${quote(d.line)}).` : 'Not published: the policy keeps this out of the repo.';
  if (code === 'below_bar') return 'Not published: the policy check has not been measured well enough to publish on its own yet, so a person decides.';
  if (code.startsWith('model_')) return d.line ? `Not published: the policy does not clearly allow it, so it stays in buildd (closest line: ${quote(d.line)}).` : 'Not published: the policy does not clearly allow it, so it stays in buildd.';
  return 'Not published: no decision model could read it against the policy, so it stays in buildd.';
}
