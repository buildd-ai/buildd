/**
 * The DB and GitHub halves of `merge-readiness-outcomes.ts`, plus the two
 * entry points that wire them: the webhook's `pr.close_delivered` subscriber
 * and the hourly pr-reconcile backstop.
 */
import { db } from '@buildd/core/db';
import { decisionOutcomes, decisionRecords, githubRepos, prReverts, workers, workspaces } from '@buildd/core/db/schema';
import type { PrCommitFact, PrFileDiff } from '@buildd/core/merge-readiness-outcome';
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { installationIdForRepo } from '@/lib/workspace-installation';
import { MERGE_READINESS_KIND, MERGE_READINESS_SUBJECT_TYPE, parseMergeAdviceSubjectId } from './merge-advice';
import {
  PR_REVERT_SOURCE,
  PR_TERMINAL_SOURCE,
  attachMergeReadinessOutcomes,
  sweepMergeReadinessReverts,
  type AttachResult,
  type MergeReadinessGithub,
  type MergeReadinessOutcomeDeps,
  type PendingDecisionHead,
  type RevertCandidate,
  type RevertSweepDeps,
} from './merge-readiness-outcomes';

/** Decisions older than this are not swept: a PR open for a month is rare, and the scan stays bounded. */
const SWEEP_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
const SWEEP_PR_LIMIT = 25;
const MAX_FILE_PAGES = 30;
const MAX_COMMIT_PAGES = 3;

/** Decision records on `prNumber` (in any of the workspaces) with no `pr_terminal` label, one per head. */
async function findPendingHeads(q: { workspaceIds: string[]; prNumber: number }): Promise<PendingDecisionHead[]> {
  const rows = await db.select({
    teamId: decisionRecords.teamId,
    subjectId: decisionRecords.subjectId,
    createdAt: decisionRecords.createdAt,
  }).from(decisionRecords)
    .leftJoin(decisionOutcomes, and(eq(decisionOutcomes.decisionRecordId, decisionRecords.id), eq(decisionOutcomes.source, PR_TERMINAL_SOURCE)))
    .where(and(
      inArray(decisionRecords.workspaceId, q.workspaceIds),
      eq(decisionRecords.capability, MERGE_READINESS_KIND),
      eq(decisionRecords.subjectType, MERGE_READINESS_SUBJECT_TYPE),
      or(...q.workspaceIds.map(ws => like(decisionRecords.subjectId, `${ws}#${q.prNumber}@%`))),
      isNull(decisionOutcomes.id),
    ))
    .orderBy(asc(decisionRecords.createdAt))
    .limit(200);
  return headsFromRows(rows);
}

/** Group record rows by subject (one head), keeping the first decision's time. */
export function headsFromRows(rows: Array<{ teamId: string; subjectId: string | null; createdAt: Date }>): PendingDecisionHead[] {
  const heads = new Map<string, PendingDecisionHead>();
  for (const r of rows) {
    const subject = r.subjectId ? parseMergeAdviceSubjectId(r.subjectId) : null;
    if (!subject) continue;
    const prev = heads.get(r.subjectId!);
    if (!prev || r.createdAt < prev.decidedAt) {
      heads.set(r.subjectId!, { teamId: r.teamId, workspaceId: subject.workspaceId, prNumber: subject.prNumber, headSha: subject.headSha, decidedAt: r.createdAt });
    }
  }
  return [...heads.values()];
}

interface GhFile { filename: string; status?: string; patch?: string; sha?: string; previous_filename?: string }

const toDiff = (files: unknown): PrFileDiff[] => (Array.isArray(files) ? files as GhFile[] : []).map(f => ({
  filename: f.filename,
  status: f.status ?? null,
  patch: f.patch ?? null,
  sha: f.sha ?? null,
  previousFilename: f.previous_filename ?? null,
}));

const dateOrNull = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);

function githubFor(repoFullName: string, installationId: number): MergeReadinessGithub {
  const api = (path: string) => githubApi(installationId, `/repos/${repoFullName}${path}`);
  return {
    async readPr(n) {
      const pr = await api(`/pulls/${n}`) as {
        state: string; merged?: boolean; merged_at?: string | null; closed_at?: string | null;
        merge_commit_sha?: string | null; head: { sha: string }; base: { sha: string };
      };
      return {
        state: pr.state === 'closed' ? 'closed' : 'open',
        merged: !!pr.merged || !!pr.merged_at,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        mergedAt: dateOrNull(pr.merged_at),
        closedAt: dateOrNull(pr.closed_at),
        mergeCommitSha: pr.merge_commit_sha ?? null,
      };
    },
    async prFiles(n) {
      const out: PrFileDiff[] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const batch = toDiff(await api(`/pulls/${n}/files?per_page=100&page=${page}`));
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    async compare(base, head) {
      try {
        const cmp = await api(`/compare/${base}...${head}`) as { merge_base_commit?: { sha?: string }; files?: unknown };
        return { mergeBaseSha: cmp.merge_base_commit?.sha ?? '', files: toDiff(cmp.files) };
      } catch (err) {
        // A sha no branch reaches any more (force-pushed and collected) is a 404.
        if (/GitHub API error: (404|422)\b/.test((err as Error)?.message ?? '')) return 'unreachable';
        throw err;
      }
    },
    async prCommits(n) {
      const out: PrCommitFact[] = [];
      for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
        const batch = (await api(`/pulls/${n}/commits?per_page=100&page=${page}`) ?? []) as Array<{ sha: string; commit: { message: string; author?: { date?: string } | null } }>;
        out.push(...batch.map(c => ({ sha: c.sha, message: c.commit.message, authoredAt: dateOrNull(c.commit.author?.date) })));
        if (batch.length < 100) break;
      }
      return out;
    },
  };
}

export const MERGE_READINESS_OUTCOME_DEPS: MergeReadinessOutcomeDeps = { findPendingHeads, github: githubFor };

/** Workspaces bound to a repo, for a PR no worker owns. */
async function workspacesForRepo(repoFullName: string): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces)
    .innerJoin(githubRepos, eq(workspaces.githubRepoId, githubRepos.id))
    .where(eq(githubRepos.fullName, repoFullName));
  return rows.map(r => r.id);
}

/** The webhook door: a closed PR (any delivery). Never throws. */
export async function attachMergeReadinessOutcomesOnClose(e: {
  repoFullName: string; prNumber: number; installationId: number | null; workspaceId: string | null;
}): Promise<AttachResult | null> {
  if (e.installationId == null) return null;
  try {
    const workspaceIds = e.workspaceId ? [e.workspaceId] : await workspacesForRepo(e.repoFullName);
    return attachMergeReadinessOutcomes({ workspaceIds, repoFullName: e.repoFullName, prNumber: e.prNumber, installationId: e.installationId }, MERGE_READINESS_OUTCOME_DEPS);
  } catch (err) {
    console.warn(`[merge-readiness-outcomes] close of PR #${e.prNumber} failed (non-fatal):`, (err as Error)?.message ?? err);
    return null;
  }
}

// ── The hourly backstop ─────────────────────────────────────────────────────

/**
 * PRs with unlabelled decisions whose worker row already says merged or
 * closed (pr-reconcile heals that row from GitHub on the same tick, so a lost
 * close delivery costs at most a pass). Bounded to `SWEEP_PR_LIMIT` PRs.
 */
async function findSweepPrs(now: Date): Promise<Array<{ workspaceId: string; prNumber: number; repoFullName: string }>> {
  const rows = await db.selectDistinct({ subjectId: decisionRecords.subjectId, workspaceId: decisionRecords.workspaceId })
    .from(decisionRecords)
    .leftJoin(decisionOutcomes, and(eq(decisionOutcomes.decisionRecordId, decisionRecords.id), eq(decisionOutcomes.source, PR_TERMINAL_SOURCE)))
    .where(and(
      eq(decisionRecords.capability, MERGE_READINESS_KIND),
      eq(decisionRecords.subjectType, MERGE_READINESS_SUBJECT_TYPE),
      gt(decisionRecords.createdAt, new Date(now.getTime() - SWEEP_LOOKBACK_MS)),
      isNull(decisionOutcomes.id),
    ))
    .limit(2000);

  const pending = new Map<string, { workspaceId: string; prNumber: number }>();
  for (const r of rows) {
    const s = r.subjectId ? parseMergeAdviceSubjectId(r.subjectId) : null;
    if (s && r.workspaceId === s.workspaceId) pending.set(`${s.workspaceId}#${s.prNumber}`, { workspaceId: s.workspaceId, prNumber: s.prNumber });
  }
  if (pending.size === 0) return [];

  const list = [...pending.values()];
  const terminal = await db.select({ workspaceId: workers.workspaceId, prNumber: workers.prNumber, repoFullName: githubRepos.fullName })
    .from(workers)
    .innerJoin(workspaces, eq(workers.workspaceId, workspaces.id))
    .innerJoin(githubRepos, eq(workspaces.githubRepoId, githubRepos.id))
    .where(and(
      inArray(workers.workspaceId, [...new Set(list.map(p => p.workspaceId))]),
      inArray(workers.prNumber, [...new Set(list.map(p => p.prNumber))]),
      or(isNotNull(workers.mergedAt), inArray(workers.prLifecycleStatus, ['merged', 'closed'])),
    ));
  const out = new Map<string, { workspaceId: string; prNumber: number; repoFullName: string }>();
  for (const t of terminal) {
    if (!t.workspaceId || t.prNumber == null) continue;
    const key = `${t.workspaceId}#${t.prNumber}`;
    if (pending.has(key) && !out.has(key)) out.set(key, { workspaceId: t.workspaceId, prNumber: t.prNumber, repoFullName: t.repoFullName });
    if (out.size >= SWEEP_PR_LIMIT) break;
  }
  return [...out.values()];
}

async function findRevertCandidates(limit: number): Promise<RevertCandidate[]> {
  const reverted = db.select({ id: decisionOutcomes.decisionRecordId }).from(decisionOutcomes)
    .where(eq(decisionOutcomes.source, PR_REVERT_SOURCE));
  const rows = await db.select({
    decisionRecordId: decisionOutcomes.decisionRecordId,
    teamId: decisionOutcomes.teamId,
    subjectId: decisionRecords.subjectId,
    mergedAt: decisionOutcomes.observedAt,
  }).from(decisionOutcomes)
    .innerJoin(decisionRecords, eq(decisionRecords.id, decisionOutcomes.decisionRecordId))
    .where(and(
      eq(decisionOutcomes.capability, MERGE_READINESS_KIND),
      eq(decisionOutcomes.source, PR_TERMINAL_SOURCE),
      inArray(decisionOutcomes.label, ['merge_now', 'code_change']),
      sql`${decisionOutcomes.decisionRecordId} not in (${reverted})`,
    ))
    .orderBy(asc(decisionOutcomes.observedAt))
    .limit(limit);
  return rows.flatMap(r => {
    const s = r.subjectId ? parseMergeAdviceSubjectId(r.subjectId) : null;
    return s ? [{ decisionRecordId: r.decisionRecordId, teamId: r.teamId, workspaceId: s.workspaceId, prNumber: s.prNumber, mergedAt: r.mergedAt }] : [];
  });
}

async function findRevertedAt(workspaceId: string, prNumber: number): Promise<Date | null> {
  const [row] = await db.select({ createdAt: prReverts.createdAt }).from(prReverts)
    .where(and(eq(prReverts.workspaceId, workspaceId), eq(prReverts.revertedPrNumber, prNumber)))
    .orderBy(asc(prReverts.createdAt)).limit(1);
  return row?.createdAt ?? null;
}

export const REVERT_SWEEP_DEPS: RevertSweepDeps = { findRevertCandidates, findRevertedAt };

export interface MergeReadinessSweepResult {
  prs: number;
  recorded: number;
  errors: number;
  reverts: { checked: number; reverted: number; notReverted: number; errors: number };
}

/** The hourly pass: terminal labels the webhook missed, then revert labels. */
export async function sweepMergeReadinessOutcomes(now = new Date()): Promise<MergeReadinessSweepResult> {
  const out: MergeReadinessSweepResult = { prs: 0, recorded: 0, errors: 0, reverts: { checked: 0, reverted: 0, notReverted: 0, errors: 0 } };
  const prs = await findSweepPrs(now);
  const installations = new Map<string, Promise<number | null>>();
  for (const p of prs) {
    out.prs++;
    if (!installations.has(p.repoFullName)) installations.set(p.repoFullName, installationIdForRepo(p.repoFullName).catch(() => null));
    const installationId = await installations.get(p.repoFullName)!;
    if (installationId == null) { out.errors++; continue; }
    const r = await attachMergeReadinessOutcomes({ workspaceIds: [p.workspaceId], repoFullName: p.repoFullName, prNumber: p.prNumber, installationId }, MERGE_READINESS_OUTCOME_DEPS);
    out.recorded += r.recorded;
    out.errors += r.errors;
  }
  out.reverts = await sweepMergeReadinessReverts({ ...REVERT_SWEEP_DEPS, now: () => now });
  return out;
}
