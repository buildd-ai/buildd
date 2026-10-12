/**
 * Visual verdicts on spec criteria (Living Specs §11), against real Postgres:
 * a mission's platform-filed [surface audit] records what it saw on the
 * criteria of a builder task it depends on, citing its own screenshots, bound
 * to the builder's PR head only when the captured commit contains it. The
 * builder, its fix attempts, a task filed under it, an agent-filed audit and
 * an audit outside the mission are refused. GitHub and storage are injected.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { readGovernedOutcome } = await import('../../src/lib/specs/outcome');
const { recordVisualVerdict, VISUAL_EVIDENCE_RETENTION_DAYS } = await import('../../src/lib/visual-audit-spec-verdict');
const { loadVisualAuditSpecCriteria } = await import('../../src/app/api/workers/claim/visual-audit-spec-criteria');
const { buildAuditScreenshotKey } = await import('../../src/lib/storage-keys');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD = 'a'.repeat(40);
const CAPTURED = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const ACCOUNT = '00000000-0000-4000-8000-0000000000a3';
const BODY = '# Cart\n- R-1: Totals are in the shopper\'s currency.\n- AC-1: An empty cart shows the empty state.\n- AC-2: A full cart lists each line.\n';

let teamA: string; let wsA: string; let missionId: string; let otherMission: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  missionId = await seedMission(teamA, wsA);
  otherMission = await seedMission(teamA, wsA);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});

const user = () => ({ kind: 'user' as const, userId: admin });
const token = (taskId: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId: teamA, workspaceIds: null, taskScope: { taskId, workspaceId: wsA } } as any });

const copies: Array<[string, string]> = [];
const deps = (over: Partial<{ head: string | null; contains: boolean | null }> = {}) => ({
  prHead: async () => (over.head === undefined ? HEAD : over.head),
  repo: async () => ({ fullName: 'acme/shop', installationId: 1 }),
  contains: async (_i: number, _r: string, ancestor: string, head: string) => (over.contains !== undefined ? over.contains : ancestor === HEAD && head === CAPTURED),
  copy: async (from: string, to: string) => { copies.push([from, to]); },
  now: () => new Date('2026-10-12T00:00:00Z'),
});

/** An approved spec; a builder task in the mission pinned to AC-1 and AC-2; its platform-filed audit with one screenshot. */
async function setup(opts: { auditMission?: string; auditCreatedByWorker?: boolean } = {}) {
  const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Cart ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id, criteria: ['AC-1', 'AC-2'] } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [builder] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, context)
    VALUES (${wsA}::uuid, ${missionId}::uuid, ${`build cart ${rand()}`}, 'completed', 'work', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
  const [bw] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${wsA}::uuid, ${builder.id}::uuid, 'b', 'test', ${`b-${rand()}`}, 'completed') RETURNING id`);
  const [audit] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug, depends_on, context, created_by_worker_id)
    VALUES (${wsA}::uuid, ${opts.auditMission ?? missionId}::uuid, ${`[surface audit] cart ${rand()}`}, 'in_progress', 'work', 'visual-auditor',
      ${JSON.stringify([builder.id])}::jsonb, '{"surfaceAuditTrigger":"auto"}'::jsonb, ${opts.auditCreatedByWorker ? bw.id : null}::uuid) RETURNING id`);
  const shot = await screenshot(audit.id);
  return { specId: d.spec.id, builderId: builder.id, builderWorkerId: bw.id, auditId: audit.id, shot };
}

async function screenshot(taskId: string) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${wsA}::uuid, ${taskId}::uuid, 'w', 'test', ${`w-${rand()}`}, 'running') RETURNING id`);
  const id = crypto.randomUUID();
  await q(sql`INSERT INTO artifacts (id, workspace_id, worker_id, type, title, storage_key)
    VALUES (${id}::uuid, ${wsA}::uuid, ${w.id}::uuid, 'screenshot', 'cart', ${buildAuditScreenshotKey(wsA, id, 'cart-mobile.png')})`);
  return id;
}

const outcome = async (taskId: string) => {
  const r = await readGovernedOutcome(user(), taskId);
  if (!r.ok) throw new Error(r.error);
  return r.outcome;
};

describe('the visual audit grades the criteria of the tasks it reviews', () => {
  test('claim lists each pinned dependency\'s scoped criteria with their text and revision', async () => {
    const s = await setup();
    const subjects = await loadVisualAuditSpecCriteria([s.builderId]);
    expect(subjects).toEqual([expect.objectContaining({
      taskId: s.builderId, revision: 1,
      criteria: [{ id: 'AC-1', text: 'An empty cart shows the empty state.' }, { id: 'AC-2', text: 'A full cart lists each line.' }],
    })]);
  });

  test('a pass citing its own screenshot binds to the PR head, keeps the shot, and shows on the outcome', async () => {
    const s = await setup();
    copies.length = 0;
    const r = await recordVisualVerdict(token(s.auditId), s.builderId, { criterionId: 'AC-1', verdict: 'pass', capturedSha: CAPTURED, screenshotIds: [s.shot], observed: 'Empty cart shows the empty state.' }, deps());
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome.criteria.find((c) => c.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass', headSha: HEAD });
    expect(copies).toHaveLength(1);
    expect(copies[0][0]).toStartWith(`qa/${wsA}/`);
    expect(copies[0][1]).toStartWith(`artifacts/${wsA}/`);
    const [row] = await q<{ head_sha: string; evidence: any }>(sql`SELECT head_sha, evidence FROM spec_outcome_verdicts WHERE id = ${r.verdictId}::uuid`);
    expect(row.head_sha).toBe(HEAD);
    expect(row.evidence).toMatchObject({
      checker: 'visual', capturedSha: CAPTURED, recordedBy: `visual:${s.auditId}`,
      retainUntil: new Date(Date.parse('2026-10-12T00:00:00Z') + VISUAL_EVIDENCE_RETENTION_DAYS * 86_400_000).toISOString(),
    });
    expect(row.evidence.refs).toEqual([{ kind: 'screenshot', ref: s.shot }, { kind: 'retained', ref: copies[0][1] }, { kind: 'capture', ref: CAPTURED }]);
    // AC-2 has no verdict yet: unverified, never pass.
    expect((await outcome(s.builderId)).outcome).toBe('unverified');
  });

  test('the builder, a fix attempt, a task filed under it, an agent-filed audit and another mission\'s audit are refused', async () => {
    const s = await setup();
    const input = { criterionId: 'AC-1', verdict: 'pass', capturedSha: CAPTURED, screenshotIds: [s.shot] };
    expect(await recordVisualVerdict(token(s.builderId), s.builderId, input, deps())).toMatchObject({ ok: false, status: 403 });
    const [fix] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, parent_task_id, task_class, delivery_role, role_slug, depends_on)
      VALUES (${wsA}::uuid, ${missionId}::uuid, ${`[surface audit] fix ${rand()}`}, 'in_progress', ${s.builderId}::uuid, 'attempt', 'fix', 'visual-auditor', ${JSON.stringify([s.builderId])}::jsonb) RETURNING id`);
    expect(await recordVisualVerdict(token(fix.id), s.builderId, { ...input, screenshotIds: [await screenshot(fix.id)] }, deps())).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('never grades its own') });
    const agentAudit = await setup({ auditCreatedByWorker: true });
    expect(await recordVisualVerdict(token(agentAudit.auditId), agentAudit.builderId, { ...input, screenshotIds: [agentAudit.shot] }, deps())).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('filed by an agent') });
    const elsewhere = await setup({ auditMission: otherMission });
    expect(await recordVisualVerdict(token(elsewhere.auditId), elsewhere.builderId, { ...input, screenshotIds: [elsewhere.shot] }, deps())).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('mission') });
    expect(await recordVisualVerdict(user(), s.builderId, input, deps())).toMatchObject({ ok: false, status: 403 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id IN (${s.builderId}::uuid, ${agentAudit.builderId}::uuid, ${elsewhere.builderId}::uuid)`);
    expect(n).toBe(0);
  });

  test('a pass with no screenshot, or someone else\'s screenshot, is refused; unsupported is refused', async () => {
    const s = await setup();
    const base = { criterionId: 'AC-1', verdict: 'pass', capturedSha: CAPTURED };
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, base, deps())).toMatchObject({ ok: false, status: 400 });
    const [bshot] = [crypto.randomUUID()];
    await q(sql`INSERT INTO artifacts (id, workspace_id, worker_id, type, title, storage_key) VALUES (${bshot}::uuid, ${wsA}::uuid, ${s.builderWorkerId}::uuid, 'screenshot', 'x', ${buildAuditScreenshotKey(wsA, bshot, 'x.png')})`);
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, { ...base, screenshotIds: [bshot] }, deps())).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('own run') });
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, { ...base, verdict: 'unsupported', screenshotIds: [s.shot] }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, { ...base, verdict: 'inconclusive' }, deps())).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('observed') });
    const inc = await recordVisualVerdict(token(s.auditId), s.builderId, { ...base, verdict: 'inconclusive', observed: 'The full-cart state needs seeded data the sandbox lacks.' }, deps());
    expect(inc.ok).toBe(true);
  });

  test('a captured commit that does not contain the PR head is refused, and nothing is recorded', async () => {
    const s = await setup();
    const input = { criterionId: 'AC-1', verdict: 'fail', capturedSha: OTHER, screenshotIds: [s.shot] };
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, input, deps())).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('does not contain') });
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, { ...input, capturedSha: CAPTURED }, deps({ contains: null }))).toMatchObject({ ok: false, status: 502 });
    expect(await recordVisualVerdict(token(s.auditId), s.builderId, { ...input, capturedSha: CAPTURED }, deps({ head: null }))).toMatchObject({ ok: false, status: 409 });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM spec_outcome_verdicts WHERE task_id = ${s.builderId}::uuid`);
    expect(n).toBe(0);
    const ok = await recordVisualVerdict(token(s.auditId), s.builderId, { ...input, capturedSha: CAPTURED }, deps());
    if (!ok.ok) throw new Error(ok.error);
    expect((await outcome(s.builderId)).outcome).toBe('fail');
  });
});
