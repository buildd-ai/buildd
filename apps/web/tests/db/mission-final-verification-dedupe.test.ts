/**
 * A mission's final verification, against real Postgres: one verification per
 * (mission, selection, target) however many evaluations race to file it, and
 * one criterion-check run per (mission, criterion, revision, head) however
 * many verification tasks of that target ask for it. Each verification used
 * to file its own check set, keyed by its own task id, and racing evaluations
 * each filed a verification.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const realDispatch = await import('../../src/lib/dispatch-authority');
mock.module('../../src/lib/dispatch-authority', () => ({ ...realDispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} }));
// The mechanical checks are exercised directly below; here they would resolve a GitHub target.
mock.module('../../src/lib/specs/mission-acceptance-checks', () => ({ runFinalAcceptanceChecks: async () => {} }));

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { dispatchCriterionChecks } = await import('../../src/lib/specs/criterion-checks');
const { ensureFinalVerification } = await import('../../src/lib/specs/mission-verification');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const BODY = [
  '# Checkout',
  'R-1: Totals are in the shopper currency.',
  '  check: `bun run scripts/run-unit-tests.ts apps/web/src/lib/fx.test.ts`',
  '- AC-1: A EUR cart shows the euro sign.',
  '  check: `bun run scripts/run-unit-tests.ts apps/web/src/lib/cart.test.ts`',
  '',
].join('\n');

let teamA: string; let wsA: string; let admin: string;
const user = (userId: string) => ({ kind: 'user' as const, userId });
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});

async function selectingMission() {
  const d = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id } });
  if (!pinned.ok) throw new Error(pinned.error);
  const pin = (pinned.context as { specSource: { specId: string; specRevisionId: string; contentHash: string } }).specSource;
  const criterion = { type: 'living_spec' as const, specId: pin.specId, specRevisionId: pin.specRevisionId, contentHash: pin.contentHash, revision: 1 };
  const [m] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title, goal_criteria)
    VALUES (${teamA}::uuid, ${wsA}::uuid, ${`Mission ${rand()}`}, ${JSON.stringify([criterion])}::jsonb) RETURNING id`);
  return { missionId: m.id, criterion };
}

async function verificationTask(missionId: string, specRevisionId: string) {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, creation_source, task_class, context)
    VALUES (${wsA}::uuid, ${missionId}::uuid, '[final verification] Checkout revision 1', 'pending', 'orchestrator', 'bookkeeping',
      ${JSON.stringify({ finalVerification: { missionId, specRevisionId, targetSha: HEAD1, targetKey: `head:${HEAD1}` } })}::jsonb)
    RETURNING id`);
  return t.id;
}

const checksOf = (missionId: string) => q<{ criterion_id: string; head_sha: string }>(sql`
  SELECT context->'specCriterionCheck'->>'criterionId' AS criterion_id, context->'specCriterionCheck'->>'headSha' AS head_sha
  FROM tasks WHERE mission_id = ${missionId}::uuid AND context ? 'specCriterionCheck' ORDER BY 1, 2`);

const noWake = { wake: async () => {} };

describe('one criterion-check run per (mission, criterion, revision, head)', () => {
  test('two final verifications of the same target produce one check task per criterion', async () => {
    const { missionId, criterion } = await selectingMission();
    const first = await verificationTask(missionId, criterion.specRevisionId);
    const second = await verificationTask(missionId, criterion.specRevisionId);
    expect((await dispatchCriterionChecks({ taskId: first, headSha: HEAD1, headBranch: 'mission/x' }, noWake)).dispatched).toBe(2);
    expect((await dispatchCriterionChecks({ taskId: second, headSha: HEAD1, headBranch: 'mission/x' }, noWake)).dispatched).toBe(0);
    expect(await checksOf(missionId)).toEqual([{ criterion_id: 'AC-1', head_sha: HEAD1 }, { criterion_id: 'R-1', head_sha: HEAD1 }]);

    // A new integrated head is a new target.
    expect((await dispatchCriterionChecks({ taskId: second, headSha: HEAD2, headBranch: 'mission/x' }, noWake)).dispatched).toBe(2);
    expect(await checksOf(missionId)).toHaveLength(4);
  });

  test('verifications racing on one head still file each criterion once', async () => {
    const { missionId, criterion } = await selectingMission();
    const ids = await Promise.all(Array.from({ length: 4 }, () => verificationTask(missionId, criterion.specRevisionId)));
    const results = await Promise.all(ids.flatMap((taskId) => [1, 2].map(() =>
      dispatchCriterionChecks({ taskId, headSha: HEAD1, headBranch: 'mission/x' }, noWake))));
    expect(results.reduce((n, r) => n + r.dispatched, 0)).toBe(2);
    expect(await checksOf(missionId)).toHaveLength(2);
  });
});

describe('one final verification per (mission, selection, target)', () => {
  test('evaluations racing on one target file one verification task, and all of them name it', async () => {
    const { missionId, criterion } = await selectingMission();
    const standing = { target: { kind: 'integration', headSha: HEAD1, branch: 'mission/x' }, scope: [], standings: [], title: 'Checkout' } as any;
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureFinalVerification(missionId, criterion, standing)));
    const rows = await q<{ id: string }>(sql`SELECT id FROM tasks WHERE mission_id = ${missionId}::uuid AND context ? 'finalVerification'`);
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'dispatched')).toHaveLength(1);
    expect(new Set(results.map((r) => ('taskId' in r ? r.taskId : r.reason)))).toEqual(new Set([rows[0].id]));
  });

  test('a second revision-matching verification is refused while one is open, even with a different fingerprint', async () => {
    const { missionId, criterion } = await selectingMission();
    const standing = { target: { kind: 'integration', headSha: HEAD1, branch: 'mission/x' }, scope: [], standings: [], title: 'Checkout' } as any;
    const results = await Promise.all([
      ensureFinalVerification(missionId, criterion, standing),
      ensureFinalVerification(missionId, { ...criterion, waived: [{ criterionId: 'R-1', reason: 'n/a', waivedBy: 'u', waivedAt: new Date().toISOString() }] } as any, standing),
    ]);
    expect(results.filter((r) => r.kind === 'dispatched')).toHaveLength(1);
    const rows = await q<{ id: string }>(sql`SELECT id FROM tasks WHERE mission_id = ${missionId}::uuid AND context ? 'finalVerification'`);
    expect(rows).toHaveLength(1);
  });
});
