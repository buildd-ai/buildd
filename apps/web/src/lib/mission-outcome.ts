/**
 * What a completed mission produced (Mission checks 072de598 I-27 to I-30,
 * Navigation d25d923d R-23 to R-27).
 *
 * A mission's outcome is not always code. A research, analysis or spec mission
 * finishes with a report, a spec or a design and has no merge or release to
 * wait for. This module decides, from facts already stored:
 *
 *  - the primary outcome: a person's choice, else the completion author's
 *    nomination (both kept only while in the pool), else, for a mission with no
 *    deliverable PR, the closeout task's single report; else none. Never the
 *    newest, the longest or a title match (I-28);
 *  - the outcome class: code, mixed, research, spec or none (I-27);
 *  - the hero's words and lines, keeping work complete, outcome ready,
 *    delivered and deployed apart (I-29, R-24).
 *
 * Pure: the page loads the inputs. Safe on the client.
 */
import { deliveredInto } from '@buildd/shared';
import { isAuditScreenshot, isReviewArtifact, type ArtifactProminenceInput } from '@/lib/artifact-prominence';
import type { MissionReleaseStatus } from '@/lib/mission-delivery';

/** The title the server gives a mission's closeout (aggregation) task. */
export const CLOSEOUT_TITLE_PREFIX = 'Aggregate results:';

/**
 * The mission's closeout task: bookkeeping by class, named by the server
 * (`task-dependencies.ts`). A row from before task classes were stored has none.
 */
export function isCloseoutTask(task: { title?: string | null; taskClass?: string | null }): boolean {
  if (task.taskClass != null && task.taskClass !== 'bookkeeping') return false;
  return (task.title ?? '').startsWith(CLOSEOUT_TITLE_PREFIX);
}

export type OutcomeClass = 'code' | 'mixed' | 'research' | 'spec' | 'none';
export type OutcomeKind = 'report' | 'spec' | 'design';
export type PrimaryOutcomeSource = 'person' | 'author' | 'closeout';

/** What the What shipped record stores (I-28); `closeout` is read at render and never stored. */
export interface StoredPrimaryOutcome {
  artifactId: string;
  source: 'person' | 'author';
  revision?: number | null;
  specId?: string | null;
  /** The person, for `source: 'person'`. */
  chosenBy?: string | null;
}

export interface OutcomeArtifactInput extends ArtifactProminenceInput {
  id: string;
  title: string | null;
  /** The task that produced it; null for an artifact on no task. */
  taskId: string | null;
}

export interface OutcomeArtifact {
  id: string;
  title: string;
  kind: OutcomeKind;
  taskId: string | null;
}

/** The two keys that are records about the mission, never its result. */
const isMissionRecordKey = (key: string | null | undefined, missionId: string) =>
  key === `mission-shipped-${missionId}` || key === `mission-${missionId}`;

function outcomeKind(a: OutcomeArtifactInput): OutcomeKind {
  const m = a.metadata ?? {};
  if (m.livingSpec === true || typeof m.specId === 'string') return 'spec';
  if (m.kind === 'design') return 'design';
  return 'report';
}

/**
 * The pool a primary outcome comes from (I-28): review artifacts and designs on
 * the mission's own tasks, in the order given (task order). Screenshots and
 * captures, the What shipped record and the `mission-<id>` Latest artifact are
 * never in it.
 */
export function outcomePool(artifacts: readonly OutcomeArtifactInput[], missionId: string): OutcomeArtifact[] {
  const seen = new Set<string>();
  const pool: OutcomeArtifact[] = [];
  for (const a of artifacts) {
    if (seen.has(a.id) || !a.taskId) continue;
    if (isMissionRecordKey(a.key, missionId)) continue;
    if (a.type === 'screenshot' || isAuditScreenshot(a)) continue;
    const design = a.metadata?.kind === 'design';
    if (!design && !isReviewArtifact(a)) continue;
    seen.add(a.id);
    pool.push({ id: a.id, title: a.title?.trim() || 'Untitled report', kind: outcomeKind(a), taskId: a.taskId });
  }
  return pool;
}

/** The stored field, or null when it is not one (an older record has none). */
export function parseStoredPrimaryOutcome(raw: unknown): StoredPrimaryOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.artifactId !== 'string' || !r.artifactId) return null;
  if (r.source !== 'person' && r.source !== 'author') return null;
  return {
    artifactId: r.artifactId,
    source: r.source,
    ...(typeof r.revision === 'number' ? { revision: r.revision } : {}),
    ...(typeof r.specId === 'string' ? { specId: r.specId } : {}),
    ...(typeof r.chosenBy === 'string' ? { chosenBy: r.chosenBy } : {}),
  };
}

export interface PrimarySelection {
  artifact: OutcomeArtifact;
  source: PrimaryOutcomeSource;
}

/**
 * I-28's order. `stored` is the record's field (a person's choice or the
 * author's validated nomination); each is kept only while its artifact is in the
 * pool. The closeout rule applies only to a mission with no deliverable PR, and
 * only when its closeout task produced exactly one artifact in the pool.
 */
export function selectPrimaryOutcome(input: {
  stored: StoredPrimaryOutcome | null;
  pool: readonly OutcomeArtifact[];
  deliverablePrCount: number;
  closeoutTaskIds: ReadonlySet<string>;
}): PrimarySelection | null {
  const { stored, pool } = input;
  if (stored) {
    const hit = pool.find(a => a.id === stored.artifactId);
    if (hit) return { artifact: hit, source: stored.source };
  }
  if (input.deliverablePrCount > 0) return null;
  const closeout = pool.filter(a => a.taskId != null && input.closeoutTaskIds.has(a.taskId));
  return closeout.length === 1 ? { artifact: closeout[0], source: 'closeout' } : null;
}

/**
 * The completion author's nomination, kept only if it names an artifact in the
 * pool: the model selects, it never asserts (the hero-shot rule).
 */
export function validateNomination(nominated: unknown, pool: readonly OutcomeArtifact[]): StoredPrimaryOutcome | null {
  if (typeof nominated !== 'string') return null;
  return pool.some(a => a.id === nominated) ? { artifactId: nominated, source: 'author' } : null;
}

/**
 * The stored field for a new record: a person's choice survives a later
 * completion (I-28 rule 1); otherwise the author's validated nomination.
 */
export function nextStoredPrimaryOutcome(previous: unknown, nominated: unknown, pool: readonly OutcomeArtifact[]): StoredPrimaryOutcome | null {
  const prior = parseStoredPrimaryOutcome(previous);
  if (prior?.source === 'person') return prior;
  return validateNomination(nominated, pool);
}

/** I-27: from PR facts and the primary outcome, never a model, a title or a task's kind. */
export function deriveOutcomeClass(input: {
  deliverablePrCount: number;
  primary: PrimarySelection | null;
  pool: readonly OutcomeArtifact[];
}): OutcomeClass {
  const { deliverablePrCount, primary } = input;
  if (deliverablePrCount > 0) return primary ? 'mixed' : 'code';
  if (primary) return primary.artifact.kind === 'report' ? 'research' : 'spec';
  return input.pool.some(a => a.kind === 'report') ? 'research' : 'none';
}

// ── Excerpt ─────────────────────────────────────────────────────────────────

export const OUTCOME_EXCERPT_MAX_CHARS = 240;

/**
 * The opening paragraph of the outcome itself, quoted (R-23): the first block
 * that is not a heading, a list, a table, a quote or code, with its markdown
 * marks removed and cut to 240 characters. Never written at render.
 */
export function outcomeExcerpt(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const blocks = markdown.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|<|---|\*\*\*|!\[)/.test(text)) continue;
    const plain = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!plain) continue;
    if (plain.length <= OUTCOME_EXCERPT_MAX_CHARS) return plain;
    const cut = plain.slice(0, OUTCOME_EXCERPT_MAX_CHARS - 1);
    const atWord = cut.lastIndexOf(' ');
    return `${(atWord > OUTCOME_EXCERPT_MAX_CHARS * 0.6 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
  }
  return null;
}

// ── The hero ────────────────────────────────────────────────────────────────

export interface OutcomeTaskCounts {
  /** Build tasks whose PR merged. */
  merged: number;
  /** Build tasks finished without a PR. */
  done: number;
}

/** R-26: `8 tasks done`, `5 merged · 3 done`, and `16 tasks merged` only when every one merged. */
export function outcomeTaskLine({ merged, done }: OutcomeTaskCounts): string {
  const tasks = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  if (done === 0) return `${tasks(merged)} merged`;
  if (merged === 0) return `${tasks(done)} done`;
  return `${merged} merged · ${done} done`;
}

const RELEASE_SUFFIX: Partial<Record<MissionReleaseStatus, string>> = {
  waiting: 'release queued',
  dispatched: 'deploying',
  deploying: 'deploying',
  failed: 'release failed',
};

/** R-24: `Delivered into dev`, with the release when one is configured, or `Work complete · not delivered`. */
export function deliveryLine(input: { shipped: boolean; target: string; release: MissionReleaseStatus; releaseLabel?: string | null }): string {
  if (!input.shipped) return 'Work complete · not delivered';
  const head = deliveredInto(input.target);
  if (input.release === 'healthy') return `${head} · deployed${input.releaseLabel ? ` ${input.releaseLabel}` : ''}`;
  const suffix = RELEASE_SUFFIX[input.release];
  return suffix ? `${head} · ${suffix}` : head;
}

export type SpecApproval = 'draft' | 'awaiting_approval' | 'approved';
const SPEC_APPROVAL_WORD: Record<SpecApproval, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
};

export interface OutcomeHeroView {
  class: OutcomeClass;
  /** The outcome words, the hero's heading (R-24). */
  words: string;
  /** The spec's approval state, as `get` shows it, for a spec outcome. */
  specState: string | null;
  primary: (OutcomeArtifact & { source: PrimaryOutcomeSource; href: string; action: string }) | null;
  /** The What shipped lede, else the outcome's own opening paragraph. */
  lede: string | null;
  ledeIsExcerpt: boolean;
  /** Code and mixed: one line (R-24). */
  delivery: string | null;
  /** Research with no primary outcome: every report, closeout first (R-25). */
  reports: Array<OutcomeArtifact & { href: string }>;
  /** Every other pool artifact, for `Supporting reports · n ›` (R-26). */
  supportingCount: number;
  /** R-26's folded task line. */
  taskLine: string;
  /** Research and spec only: the merge and release pipeline does not apply (I-30). */
  pipelineApplies: boolean;
}

export interface OutcomeHeroInput {
  missionId: string;
  artifacts: readonly OutcomeArtifactInput[];
  storedPrimary: unknown;
  closeoutTaskIds: ReadonlySet<string>;
  deliverablePrCount: number;
  tasks: OutcomeTaskCounts;
  /** The What shipped lede, when the record has one. */
  lede: string | null;
  /** The primary outcome's body, for the excerpt; null when not loaded. */
  primaryContent?: string | null;
  /** Every deliverable PR merged and, on a mission branch, the mission PR merged. */
  shipped: boolean;
  target: string;
  release: MissionReleaseStatus;
  releaseLabel?: string | null;
  specApproval?: SpecApproval | null;
}

const ACTION: Record<OutcomeKind, string> = { report: 'Open report', spec: 'Open spec', design: 'Open design' };

/** Opens the artifact in place: the Records sheet's `?artifact=` (Navigation R-2). */
export const outcomeHref = (missionId: string, artifactId: string) =>
  `/app/missions/${encodeURIComponent(missionId)}?artifact=${encodeURIComponent(artifactId)}`;

/** The selection and class without the hero, for a page that needs only those. */
export function missionOutcome(input: Pick<OutcomeHeroInput, 'missionId' | 'artifacts' | 'storedPrimary' | 'closeoutTaskIds' | 'deliverablePrCount'>) {
  const pool = outcomePool(input.artifacts, input.missionId);
  const primary = selectPrimaryOutcome({
    stored: parseStoredPrimaryOutcome(input.storedPrimary),
    pool,
    deliverablePrCount: input.deliverablePrCount,
    closeoutTaskIds: input.closeoutTaskIds,
  });
  return { pool, primary, class: deriveOutcomeClass({ deliverablePrCount: input.deliverablePrCount, primary, pool }) };
}

/**
 * The completed mission's hero (R-23 to R-26), or null when the page keeps its
 * current reading: class `none`, and `code` with no primary outcome (the What
 * shipped header stays the hero there).
 */
export function buildOutcomeHero(input: OutcomeHeroInput): OutcomeHeroView | null {
  const { pool, primary, class: cls } = missionOutcome(input);
  if (cls === 'none' || cls === 'code') return null;

  const reportCount = pool.filter(a => a.kind === 'report').length;
  const words = cls === 'research' && !primary
    ? `Outcome ready · ${reportCount} ${reportCount === 1 ? 'report' : 'reports'}`
    : 'Outcome ready';
  const excerpt = primary ? outcomeExcerpt(input.primaryContent) : null;
  const lede = input.lede?.trim() || excerpt;

  // No primary: the closeout task's reports first, then task order; none promoted (R-25).
  const reports = cls === 'research' && !primary
    ? [
        ...pool.filter(a => a.kind === 'report' && a.taskId != null && input.closeoutTaskIds.has(a.taskId)),
        ...pool.filter(a => a.kind === 'report' && !(a.taskId != null && input.closeoutTaskIds.has(a.taskId))),
      ].map(a => ({ ...a, href: outcomeHref(input.missionId, a.id) }))
    : [];

  return {
    class: cls,
    words,
    specState: primary?.artifact.kind === 'spec' && input.specApproval ? SPEC_APPROVAL_WORD[input.specApproval] : null,
    primary: primary
      ? { ...primary.artifact, source: primary.source, href: outcomeHref(input.missionId, primary.artifact.id), action: ACTION[primary.artifact.kind] }
      : null,
    lede: lede || null,
    ledeIsExcerpt: !input.lede?.trim() && !!excerpt,
    delivery: cls === 'mixed'
      ? deliveryLine({ shipped: input.shipped, target: input.target, release: input.release, releaseLabel: input.releaseLabel })
      : null,
    reports,
    supportingCount: primary ? pool.length - 1 : 0,
    taskLine: outcomeTaskLine(input.tasks),
    pipelineApplies: cls === 'mixed',
  };
}

/**
 * The What shipped record's metadata with a person's choice set or cleared
 * (I-28 rule 1). Everything else in the record is kept as it is.
 */
export function withPersonPrimaryOutcome(
  metadata: Record<string, unknown> | null | undefined,
  choice: { artifactId: string; chosenBy: string } | null,
): Record<string, unknown> {
  const shipped = { ...((metadata?.shipped as Record<string, unknown> | undefined) ?? {}) };
  if (choice) shipped.primaryOutcome = { artifactId: choice.artifactId, source: 'person', chosenBy: choice.chosenBy } satisfies StoredPrimaryOutcome;
  else delete shipped.primaryOutcome;
  return { ...(metadata ?? {}), shipped };
}
