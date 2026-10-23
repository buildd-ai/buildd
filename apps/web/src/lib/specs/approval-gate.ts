import type { SpecGateFinding, SpecGateResult } from '@buildd/core/db/schema';
import { criterionIdProblems } from '@buildd/spec-contract/requirements';
import { getArtifactRevision, getArtifactRevisions } from '@/lib/artifact-revisions';
import { db } from '@buildd/core/db';
import { specRevisions } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { hashedRecords, recordsByRevision, reusedIds, type HashedRecord, type StoredCriterion } from './criteria';
import { revisionReview, type RevisionReview } from './revision-changes';
import { attachmentViews } from './attachments';
import type { SpecRow } from './store';

/**
 * The quality gate on a spec approval request (Living Specs "writing and
 * approving a spec"): run when an approval is asked for over MCP or chat, and
 * again when a person confirms, so nobody is asked to approve a revision that
 * breaks what other work cites.
 *
 * Refusals stop the request; a person may override one on the confirm page
 * with a reason, which is recorded on the approval. Warnings never stop it.
 * Nothing here asks a model: ids and words are compared as text.
 */

/** A criterion whose words share less than this with its approved wording is another criterion. */
export const REWORDING_SIMILARITY = 0.4;
/** The same, when it also moved to another section: a move leaves less room for a rewording. */
export const MOVED_REWORDING_SIMILARITY = 0.6;
/** A revision changing more lines than this warns. */
export const LARGE_REVISION_LINES = 400;

type Rec = Pick<HashedRecord, 'id' | 'text' | 'textHash' | 'section' | 'checks' | 'screens' | 'replaces'> & { kind?: string };

export interface GateInput {
  /** The revision's criteria. */
  head: readonly Rec[];
  /** The approved revision's criteria; null while nothing is approved. */
  baseline: readonly Rec[] | null;
  /** Ids the body defines more than once. */
  duplicateIds: readonly string[];
  /** Ids that were retired and are back with other words. */
  reusedIds: ReadonlyArray<{ id: string; retiredIn: number }>;
  summary: string | null;
  changedLines: number;
  /** Pins (the design, binding attachments) whose version no longer exists, in words. */
  missingPins: readonly string[];
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Jaccard overlap of the two texts' words, 0 to 1. */
export function wordSimilarity(a: string, b: string): number {
  const x = words(a); const y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const JUDGEABLE = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b\s+\S+(?:\s+\S+){2,}/i;

/** An acceptance criterion a command, a reviewer or a screenshot can grade: a check line, named screens, or GIVEN/WHEN/THEN with an observable result. */
export function isJudgeable(r: Pick<Rec, 'text' | 'checks' | 'screens'>): boolean {
  return r.checks.length > 0 || r.screens.length > 0 || JUDGEABLE.test(r.text);
}

const list = (ids: readonly string[]) => ids.join(', ');

export function evaluateGate(input: GateInput): SpecGateResult {
  const refusals: SpecGateFinding[] = [];
  const warnings: SpecGateFinding[] = [];
  const before = new Map((input.baseline ?? []).map((r) => [r.id, r]));
  const after = new Map(input.head.map((r) => [r.id, r]));

  // An id other work cites must keep meaning what it meant.
  const changed: string[] = [];
  for (const r of input.head) {
    const old = before.get(r.id);
    if (!old || old.textHash === r.textHash) continue;
    const s = wordSimilarity(old.text, r.text);
    if (s < REWORDING_SIMILARITY || (old.section !== r.section && s < MOVED_REWORDING_SIMILARITY)) changed.push(r.id);
  }
  if (changed.length) {
    refusals.push({
      code: 'id_meaning_changed', ids: changed,
      message: `${list(changed)} now ${changed.length === 1 ? 'means' : 'mean'} something else than in the approved revision. Tasks and verdicts cite ids, so give the new meaning a new id (and say \`replaces:\` on it), or restore the old words.`,
    });
  }
  if (input.duplicateIds.length) {
    refusals.push({ code: 'duplicate_id', ids: [...input.duplicateIds], message: `${list(input.duplicateIds)} ${input.duplicateIds.length === 1 ? 'is' : 'are'} defined more than once; only the first definition counts. Give each criterion its own id.` });
  }
  if (input.reusedIds.length) {
    refusals.push({
      code: 'retired_id_reused', ids: input.reusedIds.map((r) => r.id),
      message: input.reusedIds.map((r) => `${r.id} was retired in revision ${r.retiredIn}`).join(', ') + ', and an id is never reused: give the criterion a new id, or restore the old text.',
    });
  }
  const unjudgeable = input.head
    .filter((r) => r.kind === 'acceptance' || r.id.startsWith('AC-'))
    .filter((r) => { const old = before.get(r.id); return !old || old.textHash !== r.textHash || old.checks.join() !== r.checks.join(); })
    .filter((r) => !isJudgeable(r))
    .map((r) => r.id);
  if (unjudgeable.length) {
    refusals.push({
      code: 'acceptance_unjudgeable', ids: unjudgeable,
      message: `${list(unjudgeable)} can be neither run nor judged: add a \`check:\` line, or write it as GIVEN … WHEN … THEN … with a result a reviewer or a screenshot can see.`,
    });
  }
  if (input.missingPins.length) {
    refusals.push({ code: 'pin_missing', message: `${input.missingPins.join('; ')}. Pin it to a version that exists, then ask again.` });
  }

  if (input.baseline && !input.summary?.trim()) {
    warnings.push({ code: 'no_change_summary', message: 'The revision has no change summary, so the approver has only the diff to go on.' });
  }
  if (input.changedLines > LARGE_REVISION_LINES) {
    warnings.push({ code: 'large_revision', message: `The revision changes ${input.changedLines} lines (more than ${LARGE_REVISION_LINES}); consider splitting it so each approval is reviewable.` });
  }
  const replaced = new Set(input.head.flatMap((r) => r.replaces));
  const noted = (id: string) => replaced.has(id) || new RegExp(`\\b${id}\\b`).test(input.summary ?? '');
  const dropped = [...before.keys()].filter((id) => !after.has(id) && !noted(id));
  if (dropped.length) {
    warnings.push({ code: 'removed_without_replacement', ids: dropped, message: `${list(dropped)} ${dropped.length === 1 ? 'was' : 'were'} removed with no replacement noted: name them in the change summary or on a \`replaces:\` line.` });
  }
  return { passed: refusals.length === 0, refusals, warnings };
}

/** The spec fields the gate reads. */
export type GateSpec = Pick<SpecRow, 'id' | 'bodyArtifactId' | 'approvedRevision'>;

/** Run the gate on revision `n` against the approved revision; also returns the review the confirm page shows. */
export async function runApprovalGate(spec: GateSpec & { workspaceId?: string }, n: number): Promise<{ gate: SpecGateResult; review: RevisionReview | null }> {
  const [rev] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, spec.id), eq(specRevisions.revision, n))).limit(1);
  const unreadable = { gate: { passed: false, refusals: [{ code: 'body_unreadable', message: `The text of revision ${n} could not be read, so it cannot be checked.` }], warnings: [] }, review: null };
  if (!rev) return unreadable;
  const art = (await getArtifactRevisions(spec.bodyArtifactId, [rev.artifactRevision])).get(rev.artifactRevision);
  if (!art || typeof art.content !== 'string' || art.contentHash !== rev.contentHash) return unreadable;
  const body = art.content;
  const bodies = new Map([[n, body]]);
  const baselineN = spec.approvedRevision != null && spec.approvedRevision < n ? spec.approvedRevision : null;

  const [history, review, missingPins] = await Promise.all([
    recordsByRevision(spec, { bodies }),
    revisionReview(spec, baselineN ?? 0, n, bodies),
    missingPinsOf(spec, rev.design, n),
  ]);
  const head = hashedRecords(body);
  const asRec = (r: StoredCriterion): Rec => ({ id: r.criterionId, text: r.text, textHash: r.textHash, section: r.section, checks: r.checks, screens: r.screens, replaces: r.replaces });
  const baseline = baselineN != null ? (history.get(baselineN) ?? []).map(asRec) : null;
  const before = new Map<number, StoredCriterion[]>([...history].filter(([k]) => k < n));
  const gate = evaluateGate({
    head, baseline,
    duplicateIds: criterionIdProblems(body).duplicates.map((d) => d.id),
    reusedIds: reusedIds(before, n - 1, head),
    summary: rev.changeSummary ?? null,
    changedLines: review ? review.linesAdded + review.linesRemoved : 0,
    missingPins,
  });
  return { gate, review };
}

async function missingPinsOf(spec: GateSpec, design: { kind: string; ref: string; version: string } | null, n: number): Promise<string[]> {
  const out: string[] = [];
  const checks: Array<Promise<void>> = [];
  if (design?.kind === 'artifact') {
    checks.push(getArtifactRevision(design.ref, Number(design.version)).then((r) => { if (!r) out.push(`The design is pinned to revision ${design.version} of its artifact, which no longer exists`); }));
  }
  checks.push(attachmentViews(spec, n).then(async (views) => {
    await Promise.all(views.filter((v) => v.kind === 'binding' && v.approval?.pinned != null).map(async (v) => {
      if (!(await getArtifactRevision(v.artifactId, v.approval!.pinned!))) out.push(`The binding attachment "${v.name}" is pinned to revision ${v.approval!.pinned} of its file, which no longer exists`);
    }));
  }));
  await Promise.all(checks);
  return out;
}
