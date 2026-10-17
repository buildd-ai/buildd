/**
 * Durable review findings (docs/specs/workflow-state-kernel.md §13.13 rule 2).
 *
 * A request-changes verdict leaves findings that outlive the verdict's round.
 * This file is the pure part: turning a reviewer's output into finding rows,
 * deciding which of them a later round may close, and the one question every
 * landing door asks, "does any finding still block this PR".
 *
 * A finding closes in exactly two ways: a later round at a head that changed
 * its path names it as resolved (`resolveFindings`), or a person waives it with
 * a reason (`waiverClosure`). Nothing else in the kernel writes a closure.
 */
import { createHash } from 'node:crypto';
import type { FindingSnapshot } from './types';

export interface FindingInput {
  path: string | null;
  line: number | null;
  text: string;
}

export const findingFingerprint = (f: FindingInput): string =>
  createHash('sha256').update(`${f.path ?? ''}\n${f.line ?? ''}\n${f.text.trim().replace(/\s+/g, ' ')}`).digest('hex').slice(0, 32);

const MAX_FINDINGS = 25;
const MAX_TEXT = 1500;

/**
 * The findings of a request-changes round from the reviewer's structured
 * output. A reviewer that named findings gets one row per distinct issue. One
 * that gave only prose gets a single round-scoped finding carrying that prose,
 * so a request-changes verdict can never leave nothing durable behind.
 */
export function findingsFromReview(out: {
  findings?: unknown;
  feedback?: string | null;
  summary?: string | null;
}): FindingInput[] {
  const seen = new Set<string>();
  const found: FindingInput[] = [];
  if (Array.isArray(out.findings)) {
    for (const raw of out.findings) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const text = String(r.text ?? r.message ?? r.description ?? '').trim().slice(0, MAX_TEXT);
      if (!text) continue;
      const path = typeof r.path === 'string' && r.path.trim() ? r.path.trim() : typeof r.file === 'string' && r.file.trim() ? r.file.trim() : null;
      const line = Number.isFinite(Number(r.line)) && Number(r.line) > 0 ? Math.floor(Number(r.line)) : null;
      const f = { path, line, text };
      const fp = findingFingerprint(f);
      if (seen.has(fp)) continue;
      seen.add(fp);
      found.push(f);
      if (found.length >= MAX_FINDINGS) break;
    }
  }
  if (found.length > 0) return found;
  const prose = (out.feedback ?? out.summary ?? '').trim().slice(0, MAX_TEXT);
  return [{ path: null, line: null, text: prose || 'The reviewer requested changes without naming a finding.' }];
}

export const openFindings = (findings: readonly FindingSnapshot[] | undefined): FindingSnapshot[] =>
  (findings ?? []).filter((f) => f.status === 'open');

/** What a round's scope can close: a composition delta round read only its novel paths. */
export interface ResolvingRound {
  /** Paths a composition delta round was scoped to; null for a full round. */
  deltaPaths: string[] | null;
  headSha: string;
  round: number;
  roundId: string;
}

export interface ResolveResult {
  /** Findings this round validly closes. */
  resolved: FindingSnapshot[];
  /** Findings the round named but may not close, with why. */
  refused: Array<{ id: string; reason: 'not_open' | 'path_unchanged' | 'outside_round_scope' | 'unknown' }>;
  /** Findings the round did not name: they stay open. */
  stillOpen: FindingSnapshot[];
}

/**
 * Which of the open findings the round resolves. A round closes a finding only
 * if it names it, its path changed between the finding's head and this head
 * (a round-scoped finding has no path and needs only the naming), and a delta
 * round did not exclude it by scope. Naming alone is never enough for a
 * path-scoped finding: the change has to be in the head.
 */
export function resolveFindings(
  findings: readonly FindingSnapshot[] | undefined,
  round: ResolvingRound,
  named: readonly string[] | undefined,
  changedPaths: readonly string[] | undefined,
): ResolveResult {
  const open = openFindings(findings);
  const ids = new Set(named ?? []);
  const changed = new Set(changedPaths ?? []);
  const resolved: FindingSnapshot[] = [];
  const refused: ResolveResult['refused'] = [];
  for (const id of ids) {
    const f = (findings ?? []).find((x) => x.id === id);
    if (!f) { refused.push({ id, reason: 'unknown' }); continue; }
    if (f.status !== 'open') { refused.push({ id, reason: 'not_open' }); continue; }
    if (round.deltaPaths && (f.path == null || !round.deltaPaths.includes(f.path))) { refused.push({ id, reason: 'outside_round_scope' }); continue; }
    if (f.path != null && !changed.has(f.path)) { refused.push({ id, reason: 'path_unchanged' }); continue; }
    resolved.push(f);
  }
  const resolvedIds = new Set(resolved.map((f) => f.id));
  return { resolved, refused, stillOpen: open.filter((f) => !resolvedIds.has(f.id)) };
}

export interface Waiver {
  actor: string;
  reason: string;
  /** The finding ids this waiver covers, or 'all' open findings at the time. */
  scope: string[] | 'all';
}

/** The findings a waiver closes, or why it is refused. A waiver needs a person and a reason. */
export function waiverClosure(
  findings: readonly FindingSnapshot[] | undefined,
  w: Waiver,
): { ok: true; closes: FindingSnapshot[] } | { ok: false; reason: 'waiver_requires_human' | 'waiver_requires_reason' | 'nothing_to_waive' } {
  if (!w.actor.startsWith('human:')) return { ok: false, reason: 'waiver_requires_human' };
  if (!w.reason.trim()) return { ok: false, reason: 'waiver_requires_reason' };
  const open = openFindings(findings);
  const closes = w.scope === 'all' ? open : open.filter((f) => (w.scope as string[]).includes(f.id));
  return closes.length === 0 ? { ok: false, reason: 'nothing_to_waive' } : { ok: true, closes };
}

/** One line per open finding, for a refusal, a status description or a fix task. */
export function describeFinding(f: Pick<FindingSnapshot, 'path' | 'line' | 'text'>): string {
  const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : 'whole PR';
  return `${where}: ${f.text.split('\n')[0].slice(0, 200)}`;
}
