/**
 * Server half of a review card's merge advice (merge-advice.ts): the signed
 * facts the "Ask Jev" route accepts, and the ledger read that shows an answer
 * already given.
 *
 * The facts are derived on the server when Home builds the card, then signed,
 * so the route never trusts facts a browser made up and never re-derives
 * Home's whole review pipeline. A token is bound to one (workspace, PR, head)
 * and expires; the route still checks the session's access and the live head.
 *
 * Reads `decision_records` directly (its schema is core); the decision kind
 * that writes those rows lives in merge-readiness-decision.ts.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { canonicalJson, shortHash } from '@builddai/ai-kit/decide';
import { db } from '@buildd/core/db';
import { decisionRecords } from '@buildd/core/db/schema';
import { signingSecret } from '@/lib/github-install-state';
import type { ActionQueueItem } from '@/lib/action-queue';
import {
  MERGE_READINESS_DECISIONS,
  MERGE_READINESS_KIND,
  MERGE_READINESS_SUBJECT_TYPE,
  confidenceBucket,
  mergeAdviceLine,
  mergeCiState,
  mergePolicyTier,
  parseLedgerReason,
  parseMergeAdviceFacts,
  parseMergeAdviceSubjectId,
  type MergeAdviceFacts,
  type MergeAdviceSlot,
  type MergeAdviceView,
  type MergeReadinessDecision,
  type MergeReviewState,
} from '@/lib/merge-advice';

export const MERGE_ADVICE_TOKEN_TTL_MS = 30 * 60 * 1000;
/** How far back Home looks for a stored answer. Older PR heads are rarely still open. */
export const MERGE_ADVICE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 500;

/** What the kind hashes into `fingerprint`: the parsed facts. Equal facts, equal digest. */
export function mergeAdviceDigest(facts: MergeAdviceFacts): string {
  const parsed = parseMergeAdviceFacts(facts);
  return shortHash(canonicalJson(parsed.ok ? parsed.features : facts));
}

// ── Signed facts ────────────────────────────────────────────────────────────

export interface MergeAdviceTokenPayload {
  workspaceId: string;
  prNumber: number;
  headSha: string;
  taskId: string | null;
  facts: MergeAdviceFacts;
  /** Epoch ms. */
  exp: number;
}

const DOMAIN = 'merge-advice.v1.';
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest('base64url');

/** Null when the deployment has no signing secret: the card then cannot ask. */
export function signMergeAdviceToken(input: Omit<MergeAdviceTokenPayload, 'exp'>, now = Date.now()): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify({ ...input, exp: now + MERGE_ADVICE_TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export type MergeAdviceTokenVerdict =
  | { ok: true; payload: MergeAdviceTokenPayload }
  | { ok: false; reason: 'malformed' | 'unsigned' | 'bad_signature' | 'expired' };

/** Signature first, then shape and expiry, so a forged body never reaches the caller. */
export function verifyMergeAdviceToken(token: unknown, now = Date.now()): MergeAdviceTokenVerdict {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'malformed' };
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: 'unsigned' };
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(hmac(secret, body));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad_signature' };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const facts = parseMergeAdviceFacts(p?.facts);
  if (
    !p || typeof p.workspaceId !== 'string' || typeof p.headSha !== 'string' || !p.headSha
    || typeof p.prNumber !== 'number' || !Number.isSafeInteger(p.prNumber)
    || !(p.taskId === null || typeof p.taskId === 'string') || typeof p.exp !== 'number' || !facts.ok
  ) return { ok: false, reason: 'malformed' };
  if (now >= p.exp) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    payload: { workspaceId: p.workspaceId, prNumber: p.prNumber, headSha: p.headSha, taskId: p.taskId as string | null, facts: facts.features, exp: p.exp },
  };
}

// ── Stored answers ──────────────────────────────────────────────────────────

export interface MergeAdviceRow {
  subjectId: string | null;
  fingerprint: string;
  appliedAnswer: string | null;
  reason: string | null;
  failureClass: string | null;
  createdAt: Date;
}

/**
 * Was this row an answer at all? A capability that is off or a missing key
 * records a fallback that says nothing about the PR; the card offers the ask
 * (and says why it cannot) instead of showing it.
 */
export function isAnswerRow(row: Pick<MergeAdviceRow, 'failureClass' | 'appliedAnswer'>): boolean {
  if (row.failureClass === 'capability' || row.failureClass === 'key') return false;
  return (MERGE_READINESS_DECISIONS as readonly unknown[]).includes(row.appliedAnswer);
}

/** A stored row as the card shows it, judged against the PR as it is now. */
export function adviceViewFromRow(
  row: MergeAdviceRow,
  current: { headSha: string; facts: MergeAdviceFacts },
): MergeAdviceView | null {
  if (!isAnswerRow(row)) return null;
  const subject = row.subjectId ? parseMergeAdviceSubjectId(row.subjectId) : null;
  const parsed = parseLedgerReason(row.reason);
  if (!subject || !parsed) return null;
  const decision = row.appliedAnswer as MergeReadinessDecision;
  return {
    decision,
    source: parsed.source,
    line: mergeAdviceLine(decision, parsed.source, parsed.reasonCode, current.facts),
    at: row.createdAt.toISOString(),
    stale: subject.headSha !== current.headSha ? 'new_commits'
      : row.fingerprint !== mergeAdviceDigest(current.facts) ? 'facts_changed'
      : null,
  };
}

/** The newest stored answer per `<workspace>#<pr>`, newest first in, first wins. */
export function latestAnswerPerPr(rows: readonly MergeAdviceRow[]): Map<string, MergeAdviceRow> {
  const out = new Map<string, MergeAdviceRow>();
  for (const row of rows) {
    if (!isAnswerRow(row)) continue;
    const s = row.subjectId ? parseMergeAdviceSubjectId(row.subjectId) : null;
    if (!s) continue;
    const key = `${s.workspaceId}#${s.prNumber}`;
    if (!out.has(key)) out.set(key, row);
  }
  return out;
}

export async function readMergeAdviceRows(workspaceIds: readonly string[], now = Date.now()): Promise<MergeAdviceRow[]> {
  if (workspaceIds.length === 0) return [];
  return db.select({
    subjectId: decisionRecords.subjectId,
    fingerprint: decisionRecords.fingerprint,
    appliedAnswer: decisionRecords.appliedAnswer,
    reason: decisionRecords.reason,
    failureClass: decisionRecords.failureClass,
    createdAt: decisionRecords.createdAt,
  }).from(decisionRecords).where(and(
    inArray(decisionRecords.workspaceId, [...workspaceIds]),
    eq(decisionRecords.capability, MERGE_READINESS_KIND),
    eq(decisionRecords.subjectType, MERGE_READINESS_SUBJECT_TYPE),
    gte(decisionRecords.createdAt, new Date(now - MERGE_ADVICE_LOOKBACK_MS)),
  )).orderBy(desc(decisionRecords.createdAt)).limit(MAX_ROWS);
}

/** The newest stored answer for one exact subject and facts, if one was an answer. The route's dedupe. */
export async function findStoredAnswer(
  workspaceId: string,
  subjectId: string,
  digest: string,
): Promise<MergeAdviceRow | null> {
  const rows = await db.select({
    subjectId: decisionRecords.subjectId,
    fingerprint: decisionRecords.fingerprint,
    appliedAnswer: decisionRecords.appliedAnswer,
    reason: decisionRecords.reason,
    failureClass: decisionRecords.failureClass,
    createdAt: decisionRecords.createdAt,
  }).from(decisionRecords).where(and(
    eq(decisionRecords.workspaceId, workspaceId),
    eq(decisionRecords.capability, MERGE_READINESS_KIND),
    eq(decisionRecords.subjectType, MERGE_READINESS_SUBJECT_TYPE),
    eq(decisionRecords.subjectId, subjectId),
    eq(decisionRecords.fingerprint, digest),
  )).orderBy(desc(decisionRecords.createdAt)).limit(5);
  return rows.find(isAnswerRow) ?? null;
}

// ── Home ────────────────────────────────────────────────────────────────────

/** What Home knows about a PR's review when it builds the card, beyond the item itself. */
export interface MergeAdviceBase {
  prLifecycleStatus: string | null;
  review: MergeReviewState;
  reviewConfidence: number | null;
  reviewHeadSha: string | null;
  githubApprovalRequired: boolean;
  draft: boolean;
  /** The mission-aware merge-policy tier the gate resolved. */
  policyTier: string;
}

/** The facts for one review card: the base Home computed plus what the queue resolved (blockers, CI gate, refresh fold). */
export function mergeAdviceFactsFor(item: ActionQueueItem, base: MergeAdviceBase): MergeAdviceFacts {
  const ciGateKind = item.ciGate?.kind ?? null;
  const facts = parseMergeAdviceFacts({
    ci: mergeCiState({ prLifecycleStatus: base.prLifecycleStatus, ciGateKind, mergeConflict: item.mergeConflict }),
    review: base.review,
    reviewConfidence: confidenceBucket(base.reviewConfidence),
    reviewCoversHead: !!base.reviewHeadSha && base.reviewHeadSha === item.headSha,
    blockers: (item.humanReview?.blockers ?? []).map(b => b.kind),
    policyTier: mergePolicyTier(base.policyTier),
    githubApprovalRequired: base.githubApprovalRequired,
    draft: base.draft,
    refreshFirst: !!item.refreshFirst,
    missionBlocked: !!item.missionMergeBlockedReason,
  });
  if (!facts.ok) throw new Error(`merge advice facts: ${facts.message}`);
  return facts.features;
}

/**
 * Give every human-review card its merge-advice slot: the stored answer if
 * there is one, and a token to ask. Never throws: a failed read leaves the
 * cards with no stored answer, and a card with no base stays as it was.
 */
export async function attachMergeAdvice(
  items: ActionQueueItem[],
  baseByWorkerId: ReadonlyMap<string, MergeAdviceBase>,
  deps: { readRows?: typeof readMergeAdviceRows; now?: () => number } = {},
): Promise<ActionQueueItem[]> {
  const now = deps.now?.() ?? Date.now();
  const targets = items.filter(i => i.chip === 'REVIEW' && i.humanReview && i.workerId && i.prNumber != null && i.workspaceId && i.headSha && baseByWorkerId.has(i.workerId));
  if (targets.length === 0) return items;
  let latest = new Map<string, MergeAdviceRow>();
  try {
    latest = latestAnswerPerPr(await (deps.readRows ?? readMergeAdviceRows)([...new Set(targets.map(i => i.workspaceId!))], now));
  } catch {
    console.warn('[merge-advice] stored answers unavailable');
  }
  const slots = new Map<string, MergeAdviceSlot>();
  for (const item of targets) {
    try {
      const base = baseByWorkerId.get(item.workerId!)!;
      const facts = mergeAdviceFactsFor(item, base);
      const row = latest.get(`${item.workspaceId}#${item.prNumber}`);
      const token = signMergeAdviceToken({
        workspaceId: item.workspaceId!, prNumber: item.prNumber!, headSha: item.headSha!, taskId: item.taskId ?? null, facts,
      }, now);
      slots.set(item.subjectKey, {
        prNumber: item.prNumber!,
        workspaceId: item.workspaceId!,
        advice: row ? adviceViewFromRow(row, { headSha: item.headSha!, facts }) : null,
        token,
        unavailable: token ? null : 'This server cannot sign the request.',
      });
    } catch (err) {
      console.warn('[merge-advice] slot skipped:', (err as Error)?.message ?? err);
    }
  }
  return items.map(i => (slots.has(i.subjectKey) ? { ...i, mergeAdvice: slots.get(i.subjectKey)! } : i));
}

