/**
 * Named incident scenarios, the S15 treadmill on a busy trunk (task 88318f31,
 * PR #4283): an approved, green, mergeable PR whose base moves faster than one
 * CI cycle. The base delta is disjoint from the PR and touches nothing risky,
 * so once the refresh budget is spent the kernel lands it across the gap
 * (the disjoint-delta rule) instead of escalating for a moving base. The
 * counter-cases keep every other door shut: a base that changes the PR's own
 * files or a migration, a real conflict, a base that requires up-to-date
 * branches, and a head no review covers.
 *
 * The real kernel on real Postgres against the stateful fake GitHub, through
 * the landing door (`landPr`) the sweep and the webhooks call.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { world, type OpenedPr, type World } from './workflow-scenarios-world';

const { landPr } = await import('../../src/lib/pr-landing');
const { DEFAULT_MAX_BEHIND_REFRESHES } = await import('../../src/lib/workflow/reducer');
const { observeConflict } = await import('../../src/lib/workflow/seam');

let w: World;
afterEach(() => w?.dispose());

/** The landing sweep's call: no event, system actor, enforce, merge on green. */
const sweep = (pr: OpenedPr) => landPr({
  workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, eventHeadSha: null,
  door: 'sweep', actor: { kind: 'system' }, mode: 'enforce', policy: { tier: 'auto-threshold' }, owner: { taskId: pr.ownerTaskId, workerId: pr.workerId },
});

const updateBranchCalls = (pr: OpenedPr) =>
  w.gh.calls.filter((c) => c.method === 'PUT' && c.path === `/repos/${w.repo}/pulls/${pr.prNumber}/update-branch`);

/** `n` unrelated commits land on dev (other sessions' PRs), each touching its own file. */
function trunkMoves(n: number, tag: string, extra: Record<string, string> = {}): void {
  for (let i = 0; i < n; i++) w.gh.advanceBase(w.repo, 'dev', { [`src/other-${tag}-${i}.ts`]: `export const o = ${i};\n` });
  if (Object.keys(extra).length) w.gh.advanceBase(w.repo, 'dev', extra);
}

/** Two approvals (the owner's head, then a follow-up push), CI green on each. */
async function approvedTwice(branch: string): Promise<OpenedPr> {
  const pr = await w.openPr({ branch, files: { 'src/a.ts': 'export const a = 2;\n' } });
  await w.approve(pr);
  w.gh.push(w.repo, branch, { 'src/a.ts': 'export const a = 3;\n' });
  await w.deliver();
  await w.approve(pr, w.gh.pr(w.repo, pr.prNumber).headSha);
  expect((await w.delivery(pr)).state).toBe('APPROVED');
  return pr;
}

/**
 * The busy-trunk loop: before every landing attempt dev gains more commits than
 * the ordinary bound (3) tolerates, so each attempt refreshes until the budget is
 * spent; after each refresh the new head's CI goes green.
 */
async function treadmill(pr: OpenedPr, lastMove: Record<string, string> = {}) {
  const outcomes: string[] = [];
  for (let i = 0; i <= DEFAULT_MAX_BEHIND_REFRESHES; i++) {
    trunkMoves(4, String(i), i === DEFAULT_MAX_BEHIND_REFRESHES ? lastMove : {});
    await w.deliver();
    const o = await sweep(pr);
    outcomes.push(o.kind);
    await w.deliver();
    const head = w.gh.pr(w.repo, pr.prNumber).headSha;
    if (!w.gh.pr(w.repo, pr.prNumber).merged) w.gh.greenCi(w.repo, head, ['build', 'test']);
    await w.deliver();
    if (o.kind !== 'updating_branch') break;
  }
  return outcomes;
}

async function lastTransition(pr: OpenedPr) {
  const [t] = await q<{ command: string; to_state: string; evidence: Record<string, any> }>(
    sql`SELECT command, to_state, evidence FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid ORDER BY to_version DESC LIMIT 1`);
  return t;
}

describe('#5172: the platform\'s own base refresh of an approved PR', () => {
  test('one refresh_branch (update-branch) → HeadObserved with its merge commit carries the approval as own_refresh, the delivery stays APPROVED, and the next landing merges on green with no second review', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/own-refresh', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    const approvedHead = w.gh.pr(w.repo, pr.prNumber).headSha;
    trunkMoves(1, 'r');
    await w.deliver();

    expect((await sweep(pr)).kind).toBe('updating_branch');
    await w.deliver();
    expect(updateBranchCalls(pr)).toHaveLength(1);
    const refreshed = w.gh.pr(w.repo, pr.prNumber).headSha;
    expect(refreshed).not.toBe(approvedHead);

    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'APPROVED', currentHeadSha: refreshed });
    const [seen] = await q<{ to_state: string; evidence: Record<string, any> }>(sql`SELECT to_state, evidence FROM workflow_transitions
      WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'HeadObserved' ORDER BY to_version DESC LIMIT 1`);
    expect(seen).toMatchObject({ to_state: 'APPROVED', evidence: { carryForward: 'own_refresh' } });
    // No delta round is owed, so none waits on a reviewer nobody dispatched.
    expect(await w.tasksOf(pr, 'review')).toHaveLength(1);

    w.gh.greenCi(w.repo, refreshed, ['build', 'test']);
    await w.deliver();
    expect(await sweep(pr)).toMatchObject({ kind: 'merged' });
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([200]);
    expect(updateBranchCalls(pr)).toHaveLength(1);
    expect((await w.delivery(pr)).state).toBe('MERGED');
    expect(w.gh.unsupported).toEqual([]);
  });

  test('counter-case: a push nobody in the platform made starts a review round, and its reviewer is dispatched', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/foreign-push', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    w.gh.push(w.repo, 'feat/foreign-push', { 'src/a.ts': 'export const a = 5;\n' });
    await w.deliver();

    const d = await w.delivery(pr);
    expect(d).toMatchObject({ state: 'AWAITING_REVIEW', currentHeadSha: w.gh.pr(w.repo, pr.prNumber).headSha });
    // The state that reads "waiting for its review" has a reviewer working on it.
    const reviews = await w.tasksOf(pr, 'review');
    expect(reviews).toHaveLength(2);
    expect(['pending', 'assigned', 'in_progress']).toContain(reviews.at(-1)!.status);
    expect(await sweep(pr)).not.toMatchObject({ kind: 'merged' });
    expect(w.mergeCalls(pr)).toEqual([]);
  });
});

describe('#4283: an approved, green PR on a trunk that moves faster than CI', () => {
  test('two approvals, the base gains 4 unrelated commits before every landing, three refreshes spend the budget, GitHub stays mergeable → the PR lands across the disjoint gap with no person', async () => {
    w = await world();
    const pr = await approvedTwice('feat/busy-trunk');

    const outcomes = await treadmill(pr);
    expect(outcomes).toEqual([...Array(DEFAULT_MAX_BEHIND_REFRESHES).fill('updating_branch'), 'merged']);
    expect(updateBranchCalls(pr)).toHaveLength(DEFAULT_MAX_BEHIND_REFRESHES);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(true);
    expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([200]);

    const d = await w.delivery(pr);
    expect(d.state).toBe('MERGED');
    const cmds = await w.commands(pr);
    // Never escalated on the way, and nobody overrode anything.
    expect(cmds).not.toContain('HumanApproved');
    const transitions = await q<{ to_state: string; bypass: unknown; command: string; evidence: Record<string, any> }>(
      sql`SELECT to_state, bypass, command, evidence FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid ORDER BY to_version`);
    expect(transitions.map((t) => t.to_state)).not.toContain('ESCALATED');
    expect(transitions.every((t) => t.bypass == null)).toBe(true);
    // The landing records the rule it landed under: optimistic, the gap, the spent cycle.
    const landing = transitions.find((t) => t.command === 'LandingRequested')!;
    expect(landing.evidence.freshness).toMatchObject({ optimistic: true, behindBy: 4, baseFiles: 4, rule: 'spent_cycle' });
    expect(landing.evidence.coverage).toBe('verdict');
    // The merged tree has every trunk commit and the PR's own change.
    expect(w.gh.files(w.repo, 'dev')).toMatchObject({ 'src/a.ts': 'export const a = 3;\n', 'src/other-3-0.ts': 'export const o = 0;\n' });
    expect(w.gh.unsupported).toEqual([]);
  });

  test('the base also changes a file this PR changes (no textual conflict) → no merge across the gap; the spent treadmill escalates as refresh_unsafe, naming the file', async () => {
    w = await world();
    const pr = await approvedTwice('feat/overlap');
    // The same edit the PR makes, landed on dev by someone else: clean to merge, but not disjoint.
    const outcomes = await treadmill(pr, { 'src/a.ts': 'export const a = 3;\n' });
    expect(outcomes.at(-1)).toBe('needs_human');
    expect(w.mergeCalls(pr)).toEqual([]);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    const t = await lastTransition(pr);
    expect(t).toMatchObject({ command: 'ConflictObserved', to_state: 'ESCALATED' });
    expect(t.evidence).toMatchObject({ treadmill: true, cause: 'refresh_unsafe', files: ['src/a.ts'] });
    expect(String(t.evidence.reason)).toContain('src/a.ts');
  });

  test('the base delta carries a migration → no merge across the gap; refresh_unsafe names the migration', async () => {
    w = await world();
    const pr = await approvedTwice('feat/base-migration');
    const migration = 'packages/core/drizzle/0300_other_session.sql';
    const outcomes = await treadmill(pr, { [migration]: 'ALTER TABLE t ADD COLUMN c int;\n' });
    expect(outcomes.at(-1)).toBe('needs_human');
    expect(w.mergeCalls(pr)).toEqual([]);
    const t = await lastTransition(pr);
    expect(t.evidence).toMatchObject({ treadmill: true, cause: 'refresh_unsafe', files: [migration] });
  });

  // dc4436aa: every release bumps the version in each package manifest on dev, and that alone
  // made every behind PR's gap unsafe, so each spent treadmill went to a person. The fake writes
  // a whole-file patch, so the manifest here is only its version line: the patch is that line.
  test('the base delta carries a release version bump → still landed across the gap with no person', async () => {
    w = await world({ files: { 'src/a.ts': 'export const a = 1;\n', 'apps/web/package.json': '  "version": "0.1.0",\n' } });
    const pr = await approvedTwice('feat/release-bump');
    const outcomes = await treadmill(pr, { 'apps/web/package.json': '  "version": "0.2.0",\n' });
    expect(outcomes.at(-1)).toBe('merged');
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(true);
    const states = await q<{ to_state: string }>(sql`SELECT to_state FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid`);
    expect(states.map((t) => t.to_state)).not.toContain('ESCALATED');
    expect(await w.commands(pr)).not.toContain('HumanApproved');
  });

  test('the base delta changes a manifest dependency → refresh_unsafe as a risky path, naming the manifest', async () => {
    w = await world({ files: { 'src/a.ts': 'export const a = 1;\n', 'apps/web/package.json': '  "zod": "3.0.0",\n' } });
    const pr = await approvedTwice('feat/dep-bump');
    const outcomes = await treadmill(pr, { 'apps/web/package.json': '  "zod": "4.0.0",\n' });
    expect(outcomes.at(-1)).toBe('needs_human');
    expect(w.mergeCalls(pr)).toEqual([]);
    const t = await lastTransition(pr);
    expect(t.evidence).toMatchObject({ treadmill: true, cause: 'refresh_unsafe', deltaBasis: 'risky_path', files: ['apps/web/package.json'] });
  });

  test('a treadmill hand-off whose base then conflicts → conflict repair, not a person', async () => {
    w = await world();
    const pr = await approvedTwice('feat/handoff-dirty');
    await treadmill(pr, { 'src/a.ts': 'export const a = 3;\n' });
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'landing_needs_human' });
    w.gh.advanceBase(w.repo, 'dev', { 'src/a.ts': 'export const a = 99;\n' });
    await w.deliver();
    const seen = await observeConflict({
      workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId,
      hint: 'dirty', isDependencyBot: false, maxAgentAttempts: 3, source: 'door:conflict',
    });
    expect(seen).toMatchObject({ handled: true, mergeable: 'dirty' });
    await w.deliver();
    expect(await w.delivery(pr)).toMatchObject({ state: 'REPAIRING', stateReason: 'conflict' });
    expect(await w.tasksOf(pr, 'conflict_fix')).toHaveLength(1);
  });

  test('a base that requires up-to-date branches (GitHub says behind) → the disjoint delta is not landed across; refreshes stay bounded and the escalation says why', async () => {
    w = await world();
    w.gh.protect(w.repo, 'dev', { strict: true });
    const pr = await approvedTwice('feat/protected');
    const outcomes = await treadmill(pr);
    expect(outcomes.at(-1)).toBe('needs_human');
    expect(updateBranchCalls(pr)).toHaveLength(DEFAULT_MAX_BEHIND_REFRESHES);
    expect(w.mergeCalls(pr)).toEqual([]);
    const t = await lastTransition(pr);
    expect(t.evidence).toMatchObject({ treadmill: true, cause: 'refresh_exhausted' });
    expect(String(t.evidence.deltaReason)).toContain('up-to-date');
  });

  test('a real conflict on the base → conflict repair as before (mechanical refresh refused, a conflict fix), never a merge across it', async () => {
    w = await world();
    const pr = await approvedTwice('feat/dirty');
    w.gh.advanceBase(w.repo, 'dev', { 'src/a.ts': 'export const a = 99;\n' });
    await w.deliver();
    const o = await sweep(pr);
    expect(o.kind).toBe('needs_fix');
    await w.deliver();
    expect(w.mergeCalls(pr)).toEqual([]);
    expect(await w.delivery(pr)).toMatchObject({ state: 'REPAIRING', stateReason: 'conflict' });
    expect(await w.tasksOf(pr, 'conflict_fix')).toHaveLength(1);
  });

  test('a head no review covers (a push after the approval) → the delta rule never lands it; the landing waits for review', async () => {
    w = await world();
    const pr = await approvedTwice('feat/unreviewed');
    trunkMoves(1, 'x');
    w.gh.push(w.repo, 'feat/unreviewed', { 'src/a.ts': 'export const a = 4;\n' });
    await w.deliver();
    w.gh.greenCi(w.repo, w.gh.pr(w.repo, pr.prNumber).headSha, ['build', 'test']);
    await w.deliver();
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
    const o = await sweep(pr);
    expect(o.kind).not.toBe('merged');
    expect(w.mergeCalls(pr)).toEqual([]);
    expect(updateBranchCalls(pr)).toEqual([]);
  });
});
