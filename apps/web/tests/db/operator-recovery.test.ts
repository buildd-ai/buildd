/**
 * Operator recovery on real Postgres (buildd-admin operator-recovery spec §11:
 * F-1, F-2, F-3, F-5, F-6, F-10, F-12, F-13).
 *
 * The owner's action path is the production one: `handleOperatorRecoveryAction`
 * with `productionOperatorActionDeps` (re-observation through the recovery
 * families, the shared validator and action service, the automation CAS, the
 * decision ledger and the audit table). The loop is the production
 * `assessIncident` / sweep, with pause, policy and cause peers wired in. Faked
 * only at the edges a test cannot reach: the push transport and `emit`.
 *
 * Every name is synthetic. Automation keys are cleared before and after, so a
 * pause left here can never hold another suite's repairs.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, outboxFor, q, seedMission, seedTask, seedWorkspace } from './harness';

// ── edges ───────────────────────────────────────────────────────────────────

const pushes: unknown[] = [];
const realNotify = await import('../../src/lib/notify');
mock.module('../../src/lib/notify', () => ({ ...realNotify, notifyTeam: async (...args: unknown[]) => { pushes.push(args); } }));
mock.module('../../src/lib/core-emit', () => ({ emit: async () => {} }));

const { recordOrCoalesceDeferral, GATE_SLUGS } = await import('@buildd/core/gate-events');
const { classifyCaptureFailure, formatCaptureFailureError } = await import('@buildd/core/visual-qa-page-source');
const { runFailurePatternSweep, productionSweepDeps } = await import('../../src/lib/failure-pattern-sweep');
const { assessIncident, productionRecoveryDeps, readRecovery } = await import('../../src/lib/failure-incident-recovery');
const { pathOverlapRecoveryFamily } = await import('../../src/lib/failure-incident-recovery-path-overlap');
const { createInfrastructureRecoveryFamily } = await import('../../src/lib/failure-incident-recovery-infrastructure');
const { dispatchRecoveryFamily } = await import('../../src/lib/failure-incident-recovery-dispatch');
const { createDbIncidentPort, mergeIncident } = await import('../../src/lib/failure-incident-store');
const { detectFailurePatterns } = await import('../../src/lib/failure-pattern-sentinel');
const { effectiveCauseKey, ruleCauseKey } = await import('../../src/lib/failure-incident-cause-key');
const { causeEvidenceRevisionOf, causeRevisionOf } = await import('../../src/lib/failure-incident-recovery-actions');
const { REPAIRS } = await import('../../src/lib/failure-incident-repairs');
const { projectIncident } = await import('../../src/lib/incident-view');
const { loadRecoveryCause, loadRecoveryQueue } = await import('../../src/lib/admin/data');
const { handleOperatorRecoveryAction } = await import('../../src/app/api/admin/operator/recovery-action');
const { productionOperatorActionDeps } = await import('../../src/app/api/admin/operator/recovery-action-deps');

type StoredIncident = import('../../src/lib/failure-incident-store').StoredIncident;
type SweepDeps = import('../../src/lib/failure-pattern-sweep').SweepDeps;

const OWNER = { accountId: randomUUID(), operatorLabel: 'synthetic-owner' };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const REPO = `acme/operator-recovery-${RUN}`;
let prSeq = 8000 + Math.floor(Math.random() * 1000);
const nextPr = () => ++prSeq;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const clearAutomation = () => q(sql`DELETE FROM system_cache WHERE key LIKE 'operator-recovery:%'`);

beforeAll(async () => { assertDbConfigured(); await clearAutomation(); });
afterAll(async () => { await clearAutomation(); });

// ── helpers ─────────────────────────────────────────────────────────────────

const families = [pathOverlapRecoveryFamily, createInfrastructureRecoveryFamily(), dispatchRecoveryFamily];
const port = await createDbIncidentPort();
const assess = (id: string) => assessIncident(productionRecoveryDeps(port, families), id, 'sweep');
const load = async (id: string) => (await port.findById(id))!;

async function act(body: Record<string, unknown>) {
  return handleOperatorRecoveryAction(await productionOperatorActionDeps(), OWNER, body);
}

/** An incident action on the row as the owner last saw it. */
async function actOn(id: string, capability: string, params: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const r = readRecovery(await load(id));
  return act({
    capability, target: { incidentId: id, generation: r?.generation ?? 0 }, evidenceRevision: r?.observation.evidenceRevision ?? 'none',
    params, reason: `synthetic ${capability} check`, ...over,
  });
}

/** A cause action on the members as they stand. */
async function actOnCause(causeKey: string, capability: string, params: Record<string, unknown>, evidence?: string) {
  const members = (await q<{ id: string }>(sql`SELECT id FROM failure_incidents WHERE recovery->'causeGroup'->>'key' = ${causeKey} AND status <> 'resolved'`));
  const rows = await Promise.all(members.map(m => load(m.id)));
  return act({
    capability, target: { causeKey, revision: causeRevisionOf(rows) }, evidenceRevision: evidence ?? causeEvidenceRevisionOf(rows),
    params, reason: `synthetic ${capability} check`,
  });
}

async function automationRevision(key: string): Promise<string> {
  const [r] = await q<{ at: string | null }>(sql`SELECT to_char(date_trunc('milliseconds', updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM system_cache WHERE key = ${key}`);
  return r?.at ?? 'none';
}

async function attemptRows(incidentId: string) {
  return q<{ outcome: string; detail: { actionKey: string; capability: string; actor: string; verify: { passed: boolean | null }; members?: { incidentIds: string[] } } }>(sql`
    SELECT outcome, detail FROM gate_events WHERE gate = 'incident_recovery' AND detail->>'incidentId' = ${incidentId} ORDER BY occurred_at`);
}

async function auditRows(action: string, targetId: string) {
  return q<{ id: string; before: Record<string, any>; after: Record<string, any>; actor_account_id: string }>(sql`
    SELECT id, before, after, actor_account_id FROM platform_admin_audit_events
    WHERE action = ${action} AND target_id = ${targetId} AND actor_account_id = ${OWNER.accountId}::uuid ORDER BY occurred_at`);
}

async function taskStatus(taskId: string): Promise<string> {
  const [r] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`);
  return r.status;
}

async function heldLeases(taskId: string): Promise<number> {
  const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM path_claims WHERE task_id = ${taskId}::uuid AND released_at IS NULL`);
  return Number(r.n);
}

const platformQueue = (now?: Date) => loadRecoveryQueue({ workspaceIds: [], platformWide: true, window: '7d', ...(now ? { now } : {}) });
const causeRow = async (key: string) => (await loadRecoveryCause({ workspaceIds: [], platformWide: true, window: '7d', causeKey: key }))?.cause ?? null;

// Path overlap, as the failure-incident-recovery suite seeds it.

async function prWorker(workspaceId: string, taskId: string, prNumber: number, opts: { createdMinutesAgo: number; movedMinutesAgo?: number; status?: string }) {
  await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_url, pr_number, created_at, updated_at)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'test', ${`b-${prNumber}`}, ${opts.status ?? 'completed'},
      ${`https://github.com/${REPO}/pull/${prNumber}`}, ${prNumber},
      ${ago(opts.createdMinutesAgo)}::timestamptz, ${ago(opts.movedMinutesAgo ?? opts.createdMinutesAgo)}::timestamptz)`);
}

async function deferBehind(workspaceId: string, taskId: string, blocker: { prNumber: number; taskId: string }, firstMinutesAgo: number, lastMinutesAgo: number) {
  const id = await recordOrCoalesceDeferral({
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL, surface: 'POST /api/workers/claim', outcome: 'deferred', reason: 'path_overlap',
    workspaceId, taskId, detail: { prNumber: blocker.prNumber, blockingTaskId: blocker.taskId, paths: ['src/shared/x.ts'] },
  });
  await q(sql`UPDATE gate_events SET occurred_at = ${ago(lastMinutesAgo)}::timestamptz,
    detail = jsonb_set(detail, '{firstDeferredAt}', to_jsonb(${ago(firstMinutesAgo)}::text)) WHERE id = ${id}::uuid`);
}

interface Stall { workspaceId: string; teamId: string; tasks: string[]; b: { prNumber: number; taskId: string } }

/** Three tasks wait behind PR B's claim on one path; B's wait is `waitMinutes` long. */
async function stall(opts: { waitMinutes: number; cycle?: boolean }): Promise<Stall> {
  const { workspaceId, teamId } = await seedWorkspace();
  const path = 'src/shared/x.ts';
  const tasks = [await seedTask(workspaceId, { pathManifest: [path] }), await seedTask(workspaceId, { pathManifest: [path] }), await seedTask(workspaceId, { pathManifest: [path] })];
  const bTask = await seedTask(workspaceId, { status: 'in_progress', pathManifest: [path], dependsOn: opts.cycle ? [tasks[0]] : [] });
  const b = { prNumber: nextPr(), taskId: bTask };
  await prWorker(workspaceId, bTask, b.prNumber, { createdMinutesAgo: Math.max(180, opts.waitMinutes + 30), movedMinutesAgo: 1, status: 'running' });
  await q(sql`INSERT INTO path_claims (workspace_id, task_id, path) VALUES (${workspaceId}::uuid, ${bTask}::uuid, ${path})`);
  for (const t of tasks) {
    await q(sql`INSERT INTO path_claim_waiters (workspace_id, blocking_task_id, waiting_task_id, blocked_path) VALUES (${workspaceId}::uuid, ${bTask}::uuid, ${t}::uuid, ${path})`);
    await deferBehind(workspaceId, t, b, opts.waitMinutes, 0);
  }
  await q(sql`UPDATE task_dispatch_outbox SET status = 'delivered', delivered_via = 'test:settled'
    WHERE task_id = ANY(${`{${tasks.join(',')}}`}::uuid[]) AND status IN ('pending', 'delivering')`);
  return { workspaceId, teamId, tasks, b };
}

function sweepDeps(): SweepDeps {
  const base = productionSweepDeps();
  return {
    ...base, decide: null, fixTasks: null, recordLastRun: undefined, pruneRecoveryEvents: undefined,
    async reportOpsError() {}, async recordSelfHealth() { return { consecutiveFailures: 0 }; },
  };
}
const sweep = (workspaceId: string) => runFailurePatternSweep(sweepDeps(), { workspaceIds: [workspaceId] });

async function incidentIn(workspaceId: string): Promise<StoredIncident> {
  const [r] = await q<{ id: string }>(sql`SELECT id FROM failure_incidents WHERE workspace_id = ${workspaceId}::uuid ORDER BY created_at DESC LIMIT 1`);
  expect(r).toBeTruthy();
  return load(r.id);
}

async function landB(s: Stall) {
  await q(sql`UPDATE workers SET merged_at = now(), pr_lifecycle_status = 'merged' WHERE pr_number = ${s.b.prNumber} AND workspace_id = ${s.workspaceId}::uuid`);
  await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${s.b.taskId}::uuid`);
}

// ── F-1: the QA scrub hits the immutable-revision trigger ───────────────────

describe('F-1: one scrub failure across 3 missions in 2 teams', () => {
  // The run id in the message keeps this run's platform cause apart from any other suite's.
  const SCRUB = classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: `psql:scripts/qa/scrub-pii.sql:42: ERROR:  artifact_revisions rows are immutable ${RUN}` });
  const ws: Array<{ workspaceId: string; teamId: string }> = [];
  const missions: string[] = [];
  const audits: string[] = [];
  let lead: StoredIncident;
  let member: StoredIncident;
  let causeKey: string;
  let triggersBefore: Array<{ tgname: string; tgenabled: string }>;

  const triggers = () => q<{ tgname: string; tgenabled: string }>(sql`
    SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'artifact_revisions'::regclass AND NOT tgisinternal ORDER BY tgname`);

  test('two workspaces raise two incidents that group as one platform cause', async () => {
    triggersBefore = await triggers();
    expect(triggersBefore.length).toBeGreaterThan(0);
    ws.push(await seedWorkspace(), await seedWorkspace());
    for (const [i, w] of [[0, ws[0]], [1, ws[0]], [2, ws[1]]] as const) {
      const m = await seedMission(w.teamId, w.workspaceId);
      missions.push(m);
      const a = await seedTask(w.workspaceId, { status: 'failed', missionId: m, title: `Surface audit: mission-qa-${i + 1}` });
      audits.push(a);
      await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, error, completed_at, created_at)
        VALUES (${a}::uuid, ${w.workspaceId}::uuid, 'w', 'test', 'b', 'failed', ${formatCaptureFailureError({ ...SCRUB, ref: `mission/qa-${i + 1}` } as never)}, ${ago(5)}::timestamptz, ${ago(10)}::timestamptz)`);
    }
    const open = async (w: { workspaceId: string }, taskIds: string[]) => {
      const facts = taskIds.map(t => ({ taskId: t, missionId: missions[audits.indexOf(t)], component: 'visual_qa.scrub' as const, errorSignature: SCRUB.errorSignature, occurredAt: ago(5), workerId: randomUUID(), runId: '1', ref: null }));
      const [candidate] = detectFailurePatterns({ workspaceId: w.workspaceId, now: new Date().toISOString(), captureFailures: facts });
      return (await port.insert(mergeIncident(null, candidate).next))!;
    };
    lead = await open(ws[0], [audits[0], audits[1]]);   // two audits: high
    member = await open(ws[1], [audits[2]]);            // one audit: medium
    expect(lead.severity).toBe('high');
    expect(member.severity).toBe('medium');
    expect(ruleCauseKey(lead)).toBe(ruleCauseKey(member));
  });

  test('assessed member-first: exactly one fix task, and every incident is linked to it', async () => {
    await assess(member.id);   // no peer is assessed yet: it files the cause's fix
    await assess(lead.id);     // the peer filed it: the lead follows, never files a second
    lead = await load(lead.id);
    member = await load(member.id);
    expect(member.linkedFixTaskId).toBeTruthy();
    expect(lead.linkedFixTaskId).toBe(member.linkedFixTaskId);
    const others = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks
      WHERE workspace_id IN (${ws[0].workspaceId}::uuid, ${ws[1].workspaceId}::uuid) AND NOT (id = ANY(${`{${audits.join(',')}}`}::uuid[]))`);
    expect(Number(others[0].n)).toBe(1);
    causeKey = effectiveCauseKey(lead).key;
    expect(effectiveCauseKey(member).key).toBe(causeKey);
  });

  test('the queue shows one row naming 3 missions and 2 teams; the customer is told Buildd is on it, never asked', async () => {
    const rows = (await platformQueue()).causes.filter(c => c.causeKey === causeKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].impact.missions.map(m => m.id).sort()).toEqual([...missions].sort());
    expect(rows[0].impact.teams).toHaveLength(2);
    for (const i of [lead, member]) {
      const r = readRecovery(await load(i.id))!;
      expect(r.state).not.toBe('needs_decision');
      expect(r.owner).not.toBe('person');
    }
    expect(pushes).toHaveLength(0);
  });

  test('fix finished but its PR not merged: nothing re-runs', async () => {
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${lead.linkedFixTaskId}::uuid`);
    await assess(member.id);
    await assess(lead.id);
    for (const a of audits) expect(await taskStatus(a)).toBe('failed');
    expect(readRecovery(await load(lead.id))!.state).toBe('waiting');
  });

  test("PR merged: one re-run per mission's audit, run once on the lead, on each audit's own task", async () => {
    await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, pr_number, merged_at, pr_lifecycle_status)
      VALUES (${lead.linkedFixTaskId}::uuid, ${member.workspaceId}::uuid, 'w', 'test', 'fix', 'completed', ${nextPr()}, now(), 'merged')`);
    await assess(member.id);   // a member holds for the lead
    expect(readRecovery(await load(member.id))!.nextAction?.kind).toBe('shared_repair');
    await assess(lead.id);     // the lead runs the one re-run, covering every member's audits
    for (const a of audits) expect(await taskStatus(a)).toBe('pending');
    for (const a of audits) {
      const requeued = (await outboxFor(a)).filter(r => r.cause === 'task.requeued' || r.causes.includes('task.requeued'));
      expect(requeued).toHaveLength(1);
    }
    const leadAttempts = (await attemptRows(lead.id)).filter(r => r.detail.capability === 'rerun_visual_audit');
    expect(leadAttempts).toHaveLength(1);
    expect(leadAttempts[0].detail.members?.incidentIds.sort()).toEqual([lead.id, member.id].sort());
    expect((await attemptRows(member.id)).filter(r => r.detail.capability === 'rerun_visual_audit')).toHaveLength(0);
  });

  test('a second sweep re-runs nothing and creates no new audit', async () => {
    await assess(member.id);
    await assess(lead.id);
    for (const a of audits) {
      expect((await outboxFor(a)).filter(r => r.cause === 'task.requeued' || r.causes.includes('task.requeued'))).toHaveLength(1);
    }
    for (const m of missions) {
      const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks WHERE mission_id = ${m}::uuid`);
      expect(Number(r.n)).toBe(1);
    }
  });

  test('the immutable trigger is untouched, and nothing offered or allowed can name it', async () => {
    expect(await triggers()).toEqual(triggersBefore);
    for (const spec of Object.values(REPAIRS)) expect(`${spec.kind} ${spec.writer}`).not.toMatch(/trigger|disable|sql/i);
    const row = await causeRow(causeKey);
    for (const a of row?.actions ?? []) expect(JSON.stringify(a)).not.toMatch(/trigger|disable/i);
  });
});

// ── F-13 then F-2: a paused platform, the owner's override, recovery ────────

describe('F-13 and F-2: paused automation, the owner override, then recovery', () => {
  let s: Stall;
  let incident: StoredIncident;

  test('a stall behind an open PR is assessed as waiting', async () => {
    s = await stall({ waitMinutes: 150 });
    await sweep(s.workspaceId);
    incident = await incidentIn(s.workspaceId);
    expect(readRecovery(incident)!.state).toBe('waiting');
  });

  test('the owner pauses the platform: audited, through the CAS', async () => {
    const r = await act({ capability: 'pause_automation', target: { automation: true }, evidenceRevision: 'none', params: { scope: 'platform', until: ahead(120) }, reason: 'synthetic pause' });
    expect(r.status).toBe(200);
    const audit = await auditRows('recovery.pause_automation', 'operator-recovery:pause:platform');
    expect(audit).toHaveLength(1);
    expect(audit[0].after.phase).toBe('applied');
    expect(audit[0].actor_account_id).toBe(OWNER.accountId);
    // A second pause on the stale token loses the CAS.
    const again = await act({ capability: 'pause_automation', target: { automation: true }, evidenceRevision: 'none', params: { scope: 'platform', until: ahead(60) }, reason: 'synthetic pause' });
    expect(again.status).toBe(409);
  });

  test('B merges with its claims held: no automatic release while paused; waiting with the paused next action', async () => {
    await landB(s);
    await assess(incident.id);
    expect(await heldLeases(s.b.taskId)).toBe(1);
    expect(await attemptRows(incident.id)).toHaveLength(0);
    const r = readRecovery(await load(incident.id))!;
    expect(r.state).toBe('waiting');
    expect(r.nextAction?.kind).toBe('paused');
  });

  test('the owner run_repair without overridePause: 422 paused, nothing written', async () => {
    const r = await actOn(incident.id, 'run_repair', { repair: 'release_blocker' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ result: 'rejected', reason: 'paused' });
    expect(await auditRows('recovery.run_repair', incident.id)).toHaveLength(0);
  });

  test('with overridePause: applied once, audited with before and after and the override', async () => {
    const r = await actOn(incident.id, 'run_repair', { repair: 'release_blocker', overridePause: true });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('applied');
    expect(await heldLeases(s.b.taskId)).toBe(0);
    const attempts = await attemptRows(incident.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].detail).toMatchObject({ capability: 'release_blocker', actor: `platform_admin:${OWNER.accountId}`, verify: { passed: null } });
    const audit = await auditRows('recovery.run_repair', incident.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].before.repair.budget.spent).toBe(0);
    expect(audit[0].after).toMatchObject({ phase: 'applied', overridePause: true, operatorLabel: 'synthetic-owner' });
    expect(audit[0].after.repair.budget.spent).toBe(1);
  });

  test('resume, then the tasks start: resolved, the release ran once (F-2), and the cause leaves the queue', async () => {
    const key = 'operator-recovery:pause:platform';
    const r = await act({ capability: 'resume_automation', target: { automation: true }, evidenceRevision: await automationRevision(key), params: { scope: 'platform' }, reason: 'synthetic resume' });
    expect(r.status).toBe(200);
    for (const t of s.tasks) {
      await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status) VALUES (${t}::uuid, ${s.workspaceId}::uuid, 'w', 'test', 'b', 'running')`);
      await q(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${t}::uuid`);
    }
    await assess(incident.id);
    const after = await load(incident.id);
    expect(after.status).toBe('resolved');
    expect(await attemptRows(incident.id)).toHaveLength(1);
    expect((await attemptRows(incident.id))[0].detail.verify.passed).toBe(true);
    const key2 = effectiveCauseKey(after).key;
    expect((await platformQueue()).causes.some(c => c.causeKey === key2)).toBe(false);
  });
});

// ── F-6: concurrent sweeps and an owner click ───────────────────────────────

describe('F-6: two sweeps and one owner click race on one generation', () => {
  test('exactly one attempt per action key; a click on a moved generation gets 409 with the fresh row', async () => {
    const s = await stall({ waitMinutes: 150 });
    await sweep(s.workspaceId);
    const incident = await incidentIn(s.workspaceId);
    await landB(s);
    const r = readRecovery(await load(incident.id))!;
    const click = act({
      capability: 'run_repair', target: { incidentId: incident.id, generation: r.generation }, evidenceRevision: r.observation.evidenceRevision,
      params: { repair: 'release_blocker' }, reason: 'synthetic race',
    });
    const [, , clicked] = await Promise.all([assess(incident.id), assess(incident.id), click]);
    expect([200, 409, 422]).toContain(clicked.status);
    const rows = (await attemptRows(incident.id)).filter(a => a.detail.capability === 'release_blocker');
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map(a => a.detail.actionKey)).size).toBe(rows.length);
    expect(await heldLeases(s.b.taskId)).toBe(0);

    const now = readRecovery(await load(incident.id))!;
    const stale = await act({
      capability: 'run_repair', target: { incidentId: incident.id, generation: now.generation + 5 }, evidenceRevision: now.observation.evidenceRevision,
      params: { repair: 'wake_subject' }, reason: 'synthetic stale click',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.result).toBe('stale');
    expect(stale.body.cause).toBeTruthy();
  });
});

// ── F-5: failed and exhausted repairs ───────────────────────────────────────

describe('F-5: three no-effect repairs exhaust the budget', () => {
  let incident: StoredIncident;

  test('past the deadline with the budget spent: needs_decision, tier 1, an extension offered, no repair offered', async () => {
    const s = await stall({ waitMinutes: 400 });
    await sweep(s.workspaceId);
    incident = await incidentIn(s.workspaceId);
    // Let the cause settle (FIR refines blocker_open to blocker_stuck on its next look) before spending the budget.
    await assess(incident.id);
    await assess(incident.id);
    const settled = readRecovery(await load(incident.id))!;
    const keys = [1, 2, 3].map(n => `recovery:${incident.id}:task:${s.tasks[0]}:${settled.cause.reasonCode}:wake_subject:g${settled.generation}:a${n}`);
    await q(sql`UPDATE failure_incidents SET recovery = jsonb_set(jsonb_set(recovery, '{budget,spent}', '3'::jsonb), '{budget,spentKeys}', ${JSON.stringify(keys)}::jsonb) WHERE id = ${incident.id}::uuid`);
    for (const k of keys) {
      await q(sql`INSERT INTO gate_events (gate, surface, outcome, reason, workspace_id, detail, caller_origin)
        VALUES ('incident_recovery', 'failure-incident-recovery', 'accepted', 'recovery wake_subject', ${s.workspaceId}::uuid,
          ${JSON.stringify({ actionKey: k, incidentId: incident.id, causeKey: null, capability: 'wake_subject', generation: 1, attempt: Number(k.slice(-1)), subject: { kind: 'task', id: s.tasks[0] }, actor: 'buildd:sweep', verify: { predicate: 'p', passed: false, evidenceRevision: 'r' }, costUsd: null })}::jsonb, 'system')`);
    }
    incident = await load(incident.id);
    expect(readRecovery(incident)!.state).toBe('needs_decision');
    const row = (await causeRow(effectiveCauseKey(incident).key))!;
    expect(row.rank.tier).toBe(1);
    expect(row.repair.budget.exhausted).toBe(true);
    expect(row.repair.attempts.noEffect).toBe(3);
    expect(row.actions.some(a => a.capability === 'run_repair')).toBe(false);
    expect(row.actions.filter(a => a.capability === 'retry_recovery').map(a => a.params ?? null)).toContainEqual({ extendBudgetBy: 1 });
  });

  test('a 4th repair is refused: 422 budget', async () => {
    const r = await actOn(incident.id, 'run_repair', { repair: 'wake_subject' });
    expect(r).toMatchObject({ status: 422, body: { reason: 'budget' } });
  });

  test('retry_recovery with extendBudgetBy 1: applied, the limit rises by one, audited before and after', async () => {
    const r = await actOn(incident.id, 'retry_recovery', { extendBudgetBy: 1 });
    expect(r.status).toBe(200);
    const after = readRecovery(await load(incident.id))!;
    expect(after.budget.limit).toBe(4);
    expect(after.budget.extended).toBe(1);
    const audit = await auditRows('recovery.retry_recovery', incident.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].before.repair.budget.limit).toBe(3);
    expect(audit[0].after.repair.budget.limit).toBe(4);
  });
});

// ── F-10: a genuine owner decision ──────────────────────────────────────────

describe('F-10: a path-overlap cycle is a decision', () => {
  let incident: StoredIncident;

  test('needs_decision at once; tier 1; decide offers only what it applies; admin and customer agree', async () => {
    const s = await stall({ waitMinutes: 150, cycle: true });
    await sweep(s.workspaceId);
    incident = await incidentIn(s.workspaceId);
    const r = readRecovery(incident)!;
    expect(r.state).toBe('needs_decision');
    expect(r.cause.reasonCode).toBe('path_overlap.cycle');
    const row = (await causeRow(effectiveCauseKey(incident).key))!;
    expect(row.rank.tier).toBe(1);
    const offered = row.actions.filter(a => a.capability === 'decide').map(a => a.params?.option);
    expect(offered).toEqual(r.decision!.options.map(o => o.capability).filter(c => c === 'dismiss' || c === 'retry_recovery'));
    const customer = projectIncident(incident, null);
    expect(row.state).toBe(customer.state);
    expect(row.sentence).toBe(customer.sentence);
  });

  test('an option done where its subject lives is not applied here: 422 not_supported', async () => {
    const r = await actOn(incident.id, 'decide', { option: 'cancel_attempt' });
    expect(r).toMatchObject({ status: 422, body: { reason: 'not_supported' } });
  });

  test('dismiss applies with a before/after audit; the customer view drops it from Needs You', async () => {
    const r = await actOn(incident.id, 'decide', { option: 'dismiss' });
    expect(r.status).toBe(200);
    const after = await load(incident.id);
    expect(after.status).toBe('acknowledged');
    expect(projectIncident(after, { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'r' } as never).needsYou).toBe(false);
    const audit = await auditRows('recovery.decide', incident.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].before.state).toBe('needs_decision');
    expect(audit[0].after.phase).toBe('applied');
  });
});

// ── F-3: recurring dispatch failure, in shadow then promoted ───────────────

describe('F-3: an exhausted delivery; redeliver_dispatch records in shadow, then runs once after promotion', () => {
  let incident: StoredIncident;
  let task: string;
  let workspaceId: string;

  test('shadow: records the would-run once, executes nothing', async () => {
    const w = await seedWorkspace();
    workspaceId = w.workspaceId;
    task = await seedTask(workspaceId, { title: 'Synthetic undelivered task' });
    await q(sql`UPDATE task_dispatch_outbox SET status = 'failed', attempt_count = 8 WHERE task_id = ${task}::uuid`);
    if ((await outboxFor(task)).length === 0) {
      await q(sql`INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, status, attempt_count) VALUES (${workspaceId}::uuid, ${task}::uuid, 'task.created', 'failed', 8)`);
    }
    const [acct] = await q<{ id: string }>(sql`INSERT INTO accounts (type, name, api_key, team_id, level)
      VALUES ('service', ${`svc-${RUN}`}, ${`bld_test_${RUN}`}, ${w.teamId}::uuid, 'admin') RETURNING id`);
    await q(sql`INSERT INTO worker_heartbeats (account_id, local_ui_url, workspace_ids, last_heartbeat_at)
      VALUES (${acct.id}::uuid, ${`http://runner-${RUN}.test`}, ${JSON.stringify([workspaceId])}::jsonb, now())`);
    incident = (await port.insert({
      workspaceId, signature: `repeated_failure|ws=${workspaceId}|dispatch_delivery_exhausted`, detectorVersion: 'fps-v2', rule: 'repeated_failure',
      reasonCode: 'repeated_failure.dispatch_delivery_exhausted', title: 'Synthetic delivery exhausted', severity: 'high', status: 'open',
      firstSeenAt: ago(60), lastSeenAt: ago(1), occurrenceCount: 3, recurrenceCount: 2,
      affectedRefs: { taskIds: [task], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
      lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null, recovery: null,
    }))!;
    const outboxBefore = (await outboxFor(task)).length;
    await assess(incident.id);
    await assess(incident.id);
    const rows = await attemptRows(incident.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'deferred', detail: { capability: 'redeliver_dispatch', verify: { passed: null } } });
    expect((await outboxFor(task)).length).toBe(outboxBefore);
    const r = readRecovery(await load(incident.id))!;
    expect(r.nextAction?.kind).toBe('shadow');
    expect(r.budget.spent).toBe(0);
  });

  test('set_policy promotes it (audited); it then runs once per generation', async () => {
    const p = await act({
      capability: 'set_policy', target: { automation: true }, evidenceRevision: await automationRevision('operator-recovery:policy'),
      params: { rule: 'repeated_failure', autoRepair: 'on', repair: { kind: 'redeliver_dispatch', mode: 'on' } }, reason: 'synthetic promotion after shadow review',
    });
    expect(p.status).toBe(200);
    expect(await auditRows('recovery.set_policy', 'operator-recovery:policy')).toHaveLength(1);
    const before = (await outboxFor(task)).length;
    await assess(incident.id);
    await assess(incident.id);
    const runs = (await attemptRows(incident.id)).filter(a => a.outcome === 'accepted');
    expect(runs).toHaveLength(1);
    expect((await outboxFor(task)).length).toBe(before + 1);
  });

  test('verify needs a worker: only then does it pass and resolve', async () => {
    const run = () => attemptRows(incident.id).then(rows => rows.find(a => a.outcome === 'accepted')!);
    expect((await run()).detail.verify.passed).toBeNull();
    await q(sql`INSERT INTO workers (task_id, workspace_id, name, runner, branch, status) VALUES (${task}::uuid, ${workspaceId}::uuid, 'w', 'test', 'b', 'running')`);
    await q(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${task}::uuid`);
    await q(sql`UPDATE failure_incidents SET recovery = jsonb_set(recovery, '{nextCheckAt}', to_jsonb(${ago(1)}::text)) WHERE id = ${incident.id}::uuid`);
    await assess(incident.id);
    expect((await load(incident.id)).status).toBe('resolved');
    expect((await run()).detail.verify.passed).toBe(true);
  });
});

// ── F-12: owner override limits ─────────────────────────────────────────────

describe('F-12: a tier-0 cause can be snoozed for 12 h, not 48 h', () => {
  test('48 h refused; 12 h applies, shows the baseline position, and lapses on its own', async () => {
    const { workspaceId } = await seedWorkspace();
    const task = await seedTask(workspaceId);
    const base = {
      workspaceId, signature: `stranded_gate|ws=${workspaceId}|gate=synthetic_${RUN}|stranded`, detectorVersion: 'fps-v2', rule: 'stranded_gate' as const,
      reasonCode: 'stranded_gate.stranded', title: 'Synthetic critical stall', severity: 'critical' as const, status: 'open' as const,
      firstSeenAt: ago(120), lastSeenAt: ago(1), occurrenceCount: 1, recurrenceCount: 0,
      affectedRefs: { taskIds: [task], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
      lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    };
    const key = ruleCauseKey({ ...base, recovery: null });
    const now = new Date().toISOString();
    await port.insert({
      ...base,
      recovery: {
        v: 1, generation: 1, cause: { reasonCode: base.reasonCode, rule: 'stranded_gate', ownership: 'workflow' },
        subjects: [{ kind: 'task', id: task }], blockers: [], overlappingPaths: [],
        observation: { observedAt: now, source: 'sweep', evidenceRevision: 'synthetic' }, firstSeenAt: ago(120), lastSeenAt: now, lastProgressAt: null,
        owner: 'buildd', state: 'waiting', nextAction: { kind: 'wait', label: 'Waiting.', key: 'k' }, nextCheckAt: ahead(30),
        verification: { predicate: 'p', params: {} }, budget: { spent: 0, limit: 3, deadlineAt: ahead(240), spentKeys: [] }, attempts: [],
        causeGroup: { key, source: 'rule', decisionId: null, confidence: null, assignedAt: now, ruleKey: key },
      },
    });
    expect((await causeRow(key))!.rank.tier).toBe(0);

    const refused = await actOnCause(key, 'set_priority', { mode: 'snooze', until: ahead(48 * 60) });
    expect(refused).toMatchObject({ status: 422, body: { reason: 'precondition' } });
    const ok = await actOnCause(key, 'set_priority', { mode: 'snooze', until: ahead(12 * 60) });
    expect(ok.status).toBe(200);
    const [decision] = await q<{ human_override: { mode: string; until: string }; overridden_by: string }>(sql`
      SELECT human_override, overridden_by FROM decision_records WHERE capability = 'operator_recovery.priority' AND subject_type = 'cause' AND subject_id = ${key}`);
    expect(decision.human_override.mode).toBe('snooze');
    expect(decision.overridden_by).toBe(OWNER.accountId);

    const row = (await platformQueue()).causes.find(c => c.causeKey === key)!;
    expect(row.rank.override).toMatchObject({ mode: 'snooze', by: 'synthetic-owner' });
    expect(typeof row.rank.override!.baselinePosition).toBe('number');
    expect(row.rank.tier).toBe(0); // within its tier only
    const lapsed = (await platformQueue(new Date(Date.now() + 13 * 3_600_000))).causes.find(c => c.causeKey === key);
    expect(lapsed?.rank.override ?? null).toBeNull();
  });
});
