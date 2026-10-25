/**
 * e2ea3764: a red PR whose failure came with its base gets a base refresh, never a CI-fix builder.
 *
 * #5641 branched from a dev commit whose own CI failed the DB architecture snapshot test; dev fixed
 * it twenty minutes later, before the PR went red, so the base-red rule (the base head fails the
 * same checks now) found nothing and builders were dispatched. #5639 sat on a mission branch, which
 * runs no CI of its own, after a mission refresh brought the same dev defect in. Rule (c) reads the
 * PR's branch point instead: on its base, then on the trunk.
 */
import { describe, expect, mock, test } from 'bun:test';

const scheduled: string[] = [];
mock.module('@/lib/redis', () => ({
  markDueEarliest: async (_q: string, id: string) => { scheduled.push(id); },
  clearDue: async () => undefined,
  countDue: async () => 0,
  listDue: async () => [],
}));

const { classifyCiFailure, inheritedSignature, trunkRecoveredOnRuns } = await import('./trunk');
const { baseGreenFor } = await import('@buildd/workflow-kernel/handlers/trunk');
const { ciSignature } = await import('./trunk-signature');

import type { CheckRunsRead, GithubFactReader } from '@buildd/workflow-kernel/ports';

const REPO = 'acme/app';
const SNAPSHOT = 'db architecture (real postgres)::migrated schema matches the latest snapshot > every snapshot column exists';
const prFailing = ['build', SNAPSHOT];

const red = (tests: string[]): CheckRunsRead => ({ complete: true, failing: [...new Set(tests.map((t) => t.split('::')[0]))], tests });
const green: CheckRunsRead = { complete: true, failing: [], tests: [] };
const noRuns: CheckRunsRead = { complete: false, failing: [], tests: [], pending: [] };

/** A reader over fixed commits: `heads` per branch, `points` per branch (merge-base), `runs` per sha. */
function reader(p: { heads: Record<string, string>; points: Record<string, string>; runs: Record<string, CheckRunsRead> }): GithubFactReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readPr: async () => null,
    branchHead: async (_r, ref) => p.heads[ref] ?? null,
    mergeBase: async (_r, ref) => { reads.push(`mergeBase:${ref}`); return p.points[ref] ?? null; },
    checkRuns: async (_r, sha) => p.runs[sha] ?? null,
  };
}

/** The incident upsert answers with a new row; nothing open on the base yet. */
function fakeExec() {
  const statements: string[] = [];
  const exec = async (q: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(q.queryChunks ?? '');
    statements.push(text);
    if (text.includes('workflow:trunk_open_or_join')) return { rows: [{ id: 'inc-1', opened: true }] };
    return { rows: [] };
  };
  return { exec: exec as never, statements };
}

const signature = ciSignature(prFailing);

describe('inheritedSignature', () => {
  test('#5641: the branch point on the base failed the same test, the base head is green now', async () => {
    const r = reader({ heads: { dev: 'dev-fixed' }, points: { dev: 'dev-broken' }, runs: { 'dev-broken': red(prFailing), 'dev-fixed': green } });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: r })).toBe(signature);
    // The trunk is the base: read once.
    expect(r.reads).toEqual(['mergeBase:dev']);
  });

  test('#5639: a mission base with no CI of its own; the PR\'s branch point on the trunk failed it', async () => {
    const r = reader({
      heads: { 'mission/x': 'm-head', dev: 'dev-fixed' },
      points: { 'mission/x': 'm-head', dev: 'dev-broken' },
      runs: { 'm-head': noRuns, 'dev-broken': red(prFailing), 'dev-fixed': green },
    });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'mission/x', trunkRef: 'dev', headSha: 'pr-head', signature, reader: r })).toBe(signature);
  });

  test('a branch point that was green: the PR broke it, a builder is right', async () => {
    const r = reader({ heads: { dev: 'dev-head' }, points: { dev: 'dev-old' }, runs: { 'dev-old': green, 'dev-head': green } });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: r })).toBeNull();
  });

  test('a branch point failing a different test of the same job explains nothing', async () => {
    const other = 'db architecture (real postgres)::migrations > apply in order';
    const r = reader({ heads: { dev: 'dev-head' }, points: { dev: 'dev-old' }, runs: { 'dev-old': red(['build', other]) } });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: r })).toBeNull();
  });

  test('the PR also fails something its branch point did not: not inherited', async () => {
    const extra = 'build · unit tests (1/4)::payments > refunds round down';
    const r = reader({ heads: { dev: 'dev-head' }, points: { dev: 'dev-old' }, runs: { 'dev-old': red(prFailing) } });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature: ciSignature([...prFailing, extra]), reader: r })).toBeNull();
  });

  test('unreadable: no merge-base read, or the head is its own branch point', async () => {
    const r = reader({ heads: {}, points: {}, runs: {} });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: r })).toBeNull();
    const self = reader({ heads: {}, points: { dev: 'pr-head' }, runs: { 'pr-head': red(prFailing) } });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: self })).toBeNull();
    const { mergeBase: _m, ...noCompare } = reader({ heads: {}, points: {}, runs: {} });
    expect(await inheritedSignature({ repoFullName: REPO, baseRef: 'dev', trunkRef: 'dev', headSha: 'pr-head', signature, reader: noCompare })).toBeNull();
  });
});

describe('classifyCiFailure: an inherited failure joins a trunk incident instead of a per-PR attempt', () => {
  test('#5641: base head green, branch point red on the same test → incident by rule inherited, on the recheck queue', async () => {
    const r = reader({ heads: { dev: 'dev-fixed' }, points: { dev: 'dev-broken' }, runs: { 'pr-head': red(prFailing), 'dev-broken': red(prFailing), 'dev-fixed': green } });
    const { exec, statements } = fakeExec();
    scheduled.length = 0;
    const cls = await classifyCiFailure({ workspaceId: 'ws', repoFullName: REPO, baseRef: 'dev', headSha: 'pr-head', deliveryId: 'd1', gitConfig: { defaultBranch: 'dev' }, reader: r, exec });
    expect(cls.incident).toMatchObject({ id: 'inc-1', rule: 'inherited', signature });
    expect(statements.some((s) => s.includes('workflow:trunk_open_or_join'))).toBe(true);
    // Rechecked within the fallback: dev is already green, so the incident resolves and T26 refreshes the head.
    expect(scheduled).toEqual(['inc-1']);
    expect(trunkRecoveredOnRuns(cls.incident!.signature, green)).toBe(true);
  });

  test('a failure the PR introduced still gets its per-PR attempt', async () => {
    const r = reader({ heads: { dev: 'dev-head' }, points: { dev: 'dev-old' }, runs: { 'pr-head': red(prFailing), 'dev-old': green, 'dev-head': green } });
    const { exec } = fakeExec();
    const cls = await classifyCiFailure({ workspaceId: 'ws', repoFullName: REPO, baseRef: 'dev', headSha: 'pr-head', deliveryId: 'd1', gitConfig: { defaultBranch: 'dev' }, reader: r, exec });
    expect(cls).toEqual({ signature, incident: null });
  });

  test('the base head still red keeps the base-red rule', async () => {
    const r = reader({ heads: { dev: 'dev-red' }, points: { dev: 'dev-red' }, runs: { 'pr-head': red(prFailing), 'dev-red': red(prFailing) } });
    const { exec } = fakeExec();
    const cls = await classifyCiFailure({ workspaceId: 'ws', repoFullName: REPO, baseRef: 'dev', headSha: 'pr-head', deliveryId: 'd1', gitConfig: { defaultBranch: 'dev' }, reader: r, exec });
    expect(cls.incident?.rule).toBe('base_red');
  });

  test('trunkBreaker off: no incident, whatever the branch point says', async () => {
    const r = reader({ heads: { dev: 'dev-fixed' }, points: { dev: 'dev-broken' }, runs: { 'pr-head': red(prFailing), 'dev-broken': red(prFailing) } });
    const { exec } = fakeExec();
    const cls = await classifyCiFailure({ workspaceId: 'ws', repoFullName: REPO, baseRef: 'dev', headSha: 'pr-head', deliveryId: 'd1', gitConfig: { defaultBranch: 'dev', trunkBreaker: false }, reader: r, exec });
    expect(cls.incident).toBeNull();
  });
});

describe('baseGreenFor: a busy base that passes the incident\'s checks owes no trunk fix', () => {
  test('complete and passing; or still running only checks the incident does not name', () => {
    expect(baseGreenFor(signature, green, ciSignature)).toBe(true);
    expect(baseGreenFor(signature, { complete: false, failing: [], tests: [], pending: ['Visual QA'] }, ciSignature)).toBe(true);
  });
  test('still failing, still running the incident\'s check, or no pending list: not green', () => {
    expect(baseGreenFor(signature, red(prFailing), ciSignature)).toBe(false);
    expect(baseGreenFor(signature, { complete: false, failing: [], tests: [], pending: ['db architecture (real postgres)'] }, ciSignature)).toBe(false);
    expect(baseGreenFor(signature, { complete: false, failing: [], tests: [] }, ciSignature)).toBe(false);
  });
});
