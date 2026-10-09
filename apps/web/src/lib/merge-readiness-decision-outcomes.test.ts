import { describe, expect, it } from 'bun:test';
import { labelDecisionOutcome, type OutcomeRow, type OutcomeStore } from '@buildd/core/decision-outcomes';
import type { PrFileDiff } from '@buildd/core/merge-readiness-outcome';
import { MERGE_READINESS_KIND, MERGE_READINESS_SUBJECT_TYPE, mergeAdviceSubjectId } from './merge-advice';
import {
  PR_REVERT_SOURCE,
  PR_TERMINAL_SOURCE,
  attachMergeReadinessOutcomes,
  sweepMergeReadinessReverts,
  type MergeReadinessGithub,
  type MergeReadinessOutcomeDeps,
  type PrTerminalState,
  type RevertCandidate,
} from './merge-readiness-decision-outcomes';

/**
 * The webhook and the hourly sweep both call `attachMergeReadinessOutcomes`
 * for the same PR. Whichever runs second must write nothing and read nothing
 * from GitHub. Invented fixtures: ids, shas and files are made up.
 */

const TEAM = 'team-1';
const WS = 'ws-1';
const PR = 41;

interface Rec { id: string; teamId: string; capability: string; subjectType: string; subjectId: string; createdAt: Date }

function ledger(records: Rec[]) {
  const outcomes: OutcomeRow[] = [];
  const store: OutcomeStore = {
    async findRecords(q) {
      return records
        .filter(r => r.teamId === q.teamId)
        .filter(r => (q.decisionRecordId ? r.id === q.decisionRecordId : true))
        .filter(r => (q.capability ? r.capability === q.capability : true))
        .filter(r => (q.subject ? r.subjectType === q.subject.type && r.subjectId === q.subject.id : true))
        .map(r => ({ id: r.id, capability: r.capability }));
    },
    async insertOutcome(row) {
      if (outcomes.some(o => o.decisionRecordId === row.decisionRecordId && o.source === row.source)) return false;
      outcomes.push(row);
      return true;
    },
    async readOutcome(id, source) {
      const o = outcomes.find(x => x.decisionRecordId === id && x.source === source);
      return o ? { label: o.label, value: o.value } : null;
    },
  };
  const label: typeof labelDecisionOutcome = input => labelDecisionOutcome(input, { store });
  // Mirrors the DB query: records on the PR with no pr_terminal row, one per head.
  const findPendingHeads: MergeReadinessOutcomeDeps['findPendingHeads'] = async q => {
    const heads = new Map<string, { teamId: string; workspaceId: string; prNumber: number; headSha: string; decidedAt: Date }>();
    for (const r of records) {
      const [ws, rest] = r.subjectId.split('#');
      const [n, sha] = rest.split('@');
      if (!q.workspaceIds.includes(ws) || Number(n) !== q.prNumber) continue;
      if (outcomes.some(o => o.decisionRecordId === r.id && o.source === PR_TERMINAL_SOURCE)) continue;
      const prev = heads.get(r.subjectId);
      if (!prev || r.createdAt < prev.decidedAt) heads.set(r.subjectId, { teamId: r.teamId, workspaceId: ws, prNumber: Number(n), headSha: sha, decidedAt: r.createdAt });
    }
    return [...heads.values()];
  };
  return { outcomes, label, findPendingHeads };
}

const file = (body: string): PrFileDiff => ({ filename: 'src/widget.ts', status: 'modified', patch: `@@ -1 +1 @@\n-a\n+${body}` });

function github(pr: PrTerminalState, diffs: Record<string, PrFileDiff[] | 'unreachable'>, finalFiles: PrFileDiff[]) {
  const calls: string[] = [];
  const gh: MergeReadinessGithub = {
    async readPr() { calls.push('readPr'); return pr; },
    async prFiles() { calls.push('prFiles'); return finalFiles; },
    async compare(base, head) {
      calls.push(`compare:${base}...${head}`);
      const d = diffs[head];
      if (d === 'unreachable') return 'unreachable';
      return { mergeBaseSha: base === pr.baseSha ? 'mb-0' : base, files: d ?? [] };
    },
    async prCommits() { calls.push('prCommits'); return [{ sha: 'c9', message: 'fix: real change', authoredAt: new Date('2026-01-11T00:00:00Z') }]; },
  };
  return { gh, calls };
}

const rec = (id: string, sha: string, at: string): Rec => ({
  id, teamId: TEAM, capability: MERGE_READINESS_KIND, subjectType: MERGE_READINESS_SUBJECT_TYPE,
  subjectId: mergeAdviceSubjectId(WS, PR, sha), createdAt: new Date(at),
});

const merged: PrTerminalState = {
  state: 'closed', merged: true, headSha: 'head-3', baseSha: 'base-9',
  mergedAt: new Date('2026-01-12T00:00:00Z'), closedAt: new Date('2026-01-12T00:00:00Z'), mergeCommitSha: 'mc-1',
};

const input = { workspaceIds: [WS], repoFullName: 'acme/widgets', prNumber: PR, installationId: 7 };

describe('attachMergeReadinessOutcomes', () => {
  it('labels every head on the PR, then a second pass (sweep after webhook) is a no-op with no GitHub read', async () => {
    const l = ledger([
      rec('r1', 'head-1', '2026-01-10T00:00:00Z'),
      rec('r2', 'head-1', '2026-01-10T01:00:00Z'), // re-asked on the same head
      rec('r3', 'head-2', '2026-01-10T02:00:00Z'),
      rec('r4', 'head-3', '2026-01-11T00:00:00Z'),
    ]);
    const { gh, calls } = github(merged, { 'head-1': [file('x')], 'head-2': [file('y')] }, [file('x')]);
    const deps: MergeReadinessOutcomeDeps = { findPendingHeads: l.findPendingHeads, github: () => gh, label: l.label };

    const first = await attachMergeReadinessOutcomes(input, deps);
    expect(first).toMatchObject({ status: 'labelled', recorded: 4, duplicate: 0, conflict: 0, errors: 0 });
    const byId = Object.fromEntries(l.outcomes.map(o => [o.decisionRecordId, o]));
    expect(byId.r1.label).toBe('merge_now');
    expect(byId.r2.label).toBe('merge_now');
    expect(byId.r3.label).toBe('code_change');
    expect(byId.r4.label).toBe('merge_now');
    expect(byId.r4.metadata).toMatchObject({ confidence: 'high', reason: 'head_unchanged' });
    expect(byId.r1.observedAt).toEqual(merged.mergedAt!);
    expect(l.outcomes.every(o => o.source === PR_TERMINAL_SOURCE && o.capability === MERGE_READINESS_KIND)).toBe(true);

    calls.length = 0;
    const second = await attachMergeReadinessOutcomes(input, deps);
    expect(second.status).toBe('no_pending');
    expect(calls).toEqual([]);
    expect(l.outcomes).toHaveLength(4);
  });

  it('a racing second pass that already found the heads pending writes duplicates, not new rows', async () => {
    const l = ledger([rec('r1', 'head-1', '2026-01-10T00:00:00Z')]);
    const { gh } = github(merged, { 'head-1': [file('x')] }, [file('x')]);
    const stale = await l.findPendingHeads({ workspaceIds: [WS], prNumber: PR });
    const deps: MergeReadinessOutcomeDeps = { findPendingHeads: async () => stale, github: () => gh, label: l.label };
    await attachMergeReadinessOutcomes(input, deps);
    const again = await attachMergeReadinessOutcomes(input, deps);
    expect(again).toMatchObject({ recorded: 0, duplicate: 1, conflict: 0 });
    expect(l.outcomes).toHaveLength(1);
  });

  it('an open PR writes nothing; closing it later labels it', async () => {
    const l = ledger([rec('r1', 'head-1', '2026-01-10T00:00:00Z')]);
    let pr: PrTerminalState = { ...merged, state: 'open', merged: false, mergedAt: null, closedAt: null };
    const gh = (): MergeReadinessGithub => github(pr, {}, []).gh;
    const deps: MergeReadinessOutcomeDeps = { findPendingHeads: l.findPendingHeads, github: gh, label: l.label };
    expect((await attachMergeReadinessOutcomes(input, deps)).status).toBe('open');
    expect(l.outcomes).toHaveLength(0);

    pr = { ...pr, state: 'closed', closedAt: new Date('2026-01-13T00:00:00Z') };
    expect((await attachMergeReadinessOutcomes(input, deps)).recorded).toBe(1);
    expect(l.outcomes[0]).toMatchObject({ label: 'close', observedAt: new Date('2026-01-13T00:00:00Z') });
  });

  it('a force-pushed head falls back to commits and is marked low confidence', async () => {
    const l = ledger([rec('r1', 'head-gone', '2026-01-10T00:00:00Z')]);
    const { gh, calls } = github(merged, { 'head-gone': 'unreachable' }, [file('x')]);
    await attachMergeReadinessOutcomes(input, { findPendingHeads: l.findPendingHeads, github: () => gh, label: l.label });
    expect(calls).toContain('prCommits');
    expect(l.outcomes[0]).toMatchObject({ label: 'code_change', metadata: { confidence: 'low', reason: 'force_pushed_code_change' } });
  });

  it('a GitHub read failure leaves the head unlabelled for the next pass', async () => {
    const l = ledger([rec('r1', 'head-1', '2026-01-10T00:00:00Z')]);
    const { gh } = github(merged, {}, []);
    gh.compare = async () => { throw new Error('GitHub API error: 502 bad gateway'); };
    const res = await attachMergeReadinessOutcomes(input, { findPendingHeads: l.findPendingHeads, github: () => gh, label: l.label });
    expect(res).toMatchObject({ errors: 1, recorded: 0 });
    expect(l.outcomes).toHaveLength(0);
  });

  it('a PR nobody assessed costs no GitHub call', async () => {
    const l = ledger([]);
    let built = false;
    const res = await attachMergeReadinessOutcomes(input, { findPendingHeads: l.findPendingHeads, github: () => { built = true; return github(merged, {}, []).gh; }, label: l.label });
    expect(res.status).toBe('no_pending');
    expect(built).toBe(false);
  });
});

describe('sweepMergeReadinessReverts', () => {
  const mergedAt = new Date('2026-01-12T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('labels reverted inside the window, waits while it is open, and is idempotent', async () => {
    const l = ledger([rec('r1', 'head-1', '2026-01-10T00:00:00Z'), rec('r2', 'head-1', '2026-01-10T00:00:00Z')]);
    const candidates = (): Promise<RevertCandidate[]> => Promise.resolve(
      ['r1', 'r2']
        .filter(id => !l.outcomes.some(o => o.decisionRecordId === id && o.source === PR_REVERT_SOURCE))
        .map(id => ({ decisionRecordId: id, teamId: TEAM, workspaceId: WS, prNumber: PR, mergedAt })),
    );
    let revertedAt: Date | null = null;
    const deps = { findRevertCandidates: candidates, findRevertedAt: async () => revertedAt, label: l.label };

    expect(await sweepMergeReadinessReverts({ ...deps, now: () => new Date(mergedAt.getTime() + day) }))
      .toMatchObject({ checked: 2, reverted: 0, notReverted: 0 });
    expect(l.outcomes).toHaveLength(0);

    revertedAt = new Date(mergedAt.getTime() + 2 * day);
    expect(await sweepMergeReadinessReverts({ ...deps, now: () => new Date(mergedAt.getTime() + 3 * day) }))
      .toMatchObject({ reverted: 2 });
    expect(l.outcomes.map(o => [o.source, o.label])).toEqual([[PR_REVERT_SOURCE, 'reverted'], [PR_REVERT_SOURCE, 'reverted']]);

    expect(await sweepMergeReadinessReverts({ ...deps, now: () => new Date(mergedAt.getTime() + 9 * day) }))
      .toMatchObject({ checked: 0 });
    expect(l.outcomes).toHaveLength(2);
  });

  it('labels not_reverted once the window has passed', async () => {
    const l = ledger([rec('r1', 'head-1', '2026-01-10T00:00:00Z')]);
    const res = await sweepMergeReadinessReverts({
      findRevertCandidates: async () => [{ decisionRecordId: 'r1', teamId: TEAM, workspaceId: WS, prNumber: PR, mergedAt }],
      findRevertedAt: async () => null,
      label: l.label,
      now: () => new Date(mergedAt.getTime() + 8 * day),
    });
    expect(res.notReverted).toBe(1);
    expect(l.outcomes[0]).toMatchObject({ source: PR_REVERT_SOURCE, label: 'not_reverted' });
  });
});
