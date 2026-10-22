/**
 * Registered `verify:` checks against real Postgres: the coordinator with its
 * production store (./src/lib/specs/registered-verification-store.ts). The
 * subject, revision body, scope and head are resolved from stored rows; the
 * evidence is a stored capture whose lineage (which run uploaded it, who wrote
 * its current revision, what commit it captured) decides whether it is
 * admitted; results land in spec_outcome_verdicts and read back through the
 * governed outcome; reservations and the deterministic cache are real rows.
 * Only GitHub (PR head, ancestry) and the model call are injected.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';
import type { SurfaceEvidence } from '@buildd/core/ui-verification';
import { bindingFingerprint, criterionBindings } from '@buildd/spec-contract/verification-bindings';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { readGovernedOutcome, recordRegisteredVerdict } = await import('../../src/lib/specs/outcome');
const { dispatchRegisteredVerification } = await import('../../src/lib/specs/registered-verification');
const { createRegisteredVerificationDeps, rerunRegisteredVerificationForAudit, subjectsForArrivedCaptures, surfaceAuditorRefusal, verificationRequesterRefusal } = await import('../../src/lib/specs/registered-verification-store');
const { executeUiVerification } = await import('../../src/lib/specs/ui-verification-decision');
const { buildAuditScreenshotKey } = await import('../../src/lib/storage-keys');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD = 'a'.repeat(40);
const CAPTURED = 'c'.repeat(40);
const ELSEWHERE = 'd'.repeat(40);
const STATE = { id: 'ui.actions_match_state', version: 1, profile: 'buildd.enterprise@1', mode: 'required' };
const CLARITY = { id: 'ui.card_clarity', version: 1, profile: 'buildd.enterprise@1', mode: 'required' };
const BODY = [
  '# Task card',
  '- AC-1: The card offers only actions the PR state allows.',
  `  verify: ${JSON.stringify(STATE)}`,
  '  scenarios: closed-pr@mobile',
  '- AC-2: The card says each thing once.',
  `  verify: ${JSON.stringify(CLARITY)}`,
  '  scenarios: closed-pr@mobile',
  '- AC-3: Out of scope for this task.',
  '',
].join('\n');

let teamA: string; let wsA: string; let wsB: string; let teamB: string; let missionId: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  missionId = await seedMission(teamA, wsA);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });

const surface = (): SurfaceEvidence => ({
  schemaVersion: 1,
  subject: { commitSha: HEAD, route: '/app/tasks/example', scenarioId: 'closed-pr', viewport: 'mobile' },
  capture: { captureId: 'capture-1', capturedAt: '2026-10-21T12:00:00.000Z', snapshotRef: 'snapshot-1' },
  visible: { blocks: [{ id: 'status', role: 'status', text: 'Pull request closed', order: 0, disclosure: 'visible' }], actions: [] },
  facts: { prState: 'closed', replacementState: 'none', verificationState: 'failed', shownVerificationState: 'failed' },
  provenance: { collector: 'visual_auditor', collectorVersion: '1', reportedVia: 'runner', factVersion: '1' },
  coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'absent' },
});

/** What a passing deterministic capture looks like: a closed PR that offers nothing to merge. */
const capture = (over: Partial<ReturnType<typeof surface>> = {}, sha = HEAD) => {
  const e = surface();
  return {
    ...e, ...over,
    subject: { ...e.subject, commitSha: sha },
    capture: { ...e.capture, screenshotRef: undefined },
    visible: over.visible ?? { blocks: e.visible.blocks, actions: [{ id: 'view', label: 'View replacement', operation: 'merge_pr' as const, enabled: false, prominence: 'secondary' as const, disclosure: 'visible' as const }] },
  };
};
const offersMerge = (sha = HEAD) => capture({ visible: { blocks: surface().visible.blocks, actions: [{ id: 'merge', label: 'Merge', operation: 'merge_pr', enabled: true, prominence: 'primary', disclosure: 'visible' }] } }, sha);

async function worker(workspaceId: string, taskId: string, accountId: string | null = null) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status) VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${accountId}::uuid, 'w', 'test', ${`w-${rand()}`}, 'running') RETURNING id`);
  return w.id;
}
async function storeCapture(workspaceId: string, workerId: string, content: unknown) {
  const [a] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, worker_id, type, title, content) VALUES (${workspaceId}::uuid, ${workerId}::uuid, 'data', 'surface capture', ${JSON.stringify(content)}) RETURNING id`);
  return a.id;
}

/** An approved spec; a builder pinned to AC-1 and AC-2; a platform-filed audit depending on it, with one stored capture. */
async function setup(opts: { auditCreatedByWorker?: boolean; content?: unknown; body?: string } = {}) {
  const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Card ${rand()}`, body: opts.body ?? BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id, criteria: ['AC-1', 'AC-2'] } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [builder] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, context)
    VALUES (${wsA}::uuid, ${missionId}::uuid, ${`build card ${rand()}`}, 'completed', 'work', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
  const builderWorker = await worker(wsA, builder.id);
  const [audit] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug, depends_on, context, created_by_worker_id)
    VALUES (${wsA}::uuid, ${missionId}::uuid, ${`[surface audit] card ${rand()}`}, 'in_progress', 'work', 'visual-auditor',
      ${JSON.stringify([builder.id])}::jsonb, '{"surfaceAuditTrigger":"auto"}'::jsonb, ${opts.auditCreatedByWorker ? builderWorker : null}::uuid) RETURNING id`);
  const auditWorker = await worker(wsA, audit.id);
  const evidenceId = await storeCapture(wsA, auditWorker, opts.content ?? capture());
  return { specId: d.spec.id, builderId: builder.id, builderWorker, auditId: audit.id, auditWorker, evidenceId };
}

type Exec = typeof executeUiVerification;
function harness(over: { head?: string | null; contains?: boolean | null; model?: Exec } = {}) {
  const calls: Array<{ id: string; input: unknown }> = [];
  const deps = createRegisteredVerificationDeps({
    prHead: async () => (over.head === undefined ? HEAD : over.head),
    repo: async () => ({ fullName: 'acme/shop', installationId: 1 }),
    contains: async (_i, _r, ancestor, head) => (over.contains !== undefined ? over.contains : ancestor === HEAD && head === CAPTURED),
    execute: async (id, input, scope) => {
      calls.push({ id, input });
      if (id === 'ui.card_clarity') {
        if (!over.model) throw new Error('no model provider in this test');
        return over.model(id, input, scope);
      }
      return executeUiVerification(id, input, scope);
    },
  });
  return { deps, calls };
}
const modelPass: Exec = async (id, input) => ({
  result: { ...(await executeUiVerification('ui.actions_match_state', input, { teamId: 'x' })).result, id, verdict: 'pass', observed: 'all_axes_clear' },
  method: 'model', decisionKind: 'buildd.ui_copy', decisionRecordIds: ['00000000-0000-4000-8000-00000000d001'], receipts: [], inputFingerprint: 'model-input',
});

const verdictRows = async (taskId: string) => q<{ id: string; criterion_id: string; verdict: string; head_sha: string; evidence: any }>(
  sql`SELECT id, criterion_id, verdict, head_sha, evidence FROM spec_outcome_verdicts WHERE task_id = ${taskId}::uuid ORDER BY created_at`);
const outcome = async (taskId: string) => {
  const r = await readGovernedOutcome(user(), taskId);
  if (!r.ok) throw new Error(r.error);
  return r.outcome;
};

describe('registered verification on a task, with its production store', () => {
  test('canonical key=value declarations are written, pinned, executed and read through the real store', async () => {
    const body = BODY
      .replace(JSON.stringify(STATE), 'verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state')
      .replace(JSON.stringify(CLARITY), 'verifier=ui.copy@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions');
    const s = await setup({ body });
    const h = harness({ model: modelPass });
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    expect(r.results).toHaveLength(2);
    expect(r.results.every(x => x.recorded && x.verdict === 'pass')).toBe(true);
    const canonical = criterionBindings(body).bindings;
    const legacy = criterionBindings(BODY).bindings;
    const rows = await verdictRows(s.builderId);
    for (const row of rows) {
      const binding = canonical.find(x => x.criterionId === row.criterion_id)!;
      expect(row.evidence.bindingFingerprint).toBe(bindingFingerprint(binding));
      expect(bindingFingerprint(binding)).toBe(bindingFingerprint(legacy.find(x => x.criterionId === row.criterion_id)!));
    }
    expect((await outcome(s.builderId)).criteria.every(c => c.verdict === 'pass')).toBe(true);
  });

  test('AC-2: a deterministic check runs on the audit\'s own capture at the PR head and lands as a test verdict the outcome reads', async () => {
    const s = await setup();
    const h = harness({ model: modelPass });
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    expect(r.refused).toEqual([]);
    expect(r.results).toEqual([
      { criterionId: 'AC-1', bindingId: 'ui.actions_match_state', verdict: 'pass', method: 'deterministic', cached: false, recorded: true },
      { criterionId: 'AC-2', bindingId: 'ui.card_clarity', verdict: 'pass', method: 'model', cached: false, recorded: true },
    ]);
    const rows = await verdictRows(s.builderId);
    expect(rows.map((x) => [x.criterion_id, x.verdict, x.head_sha])).toEqual([['AC-1', 'pass', HEAD], ['AC-2', 'pass', HEAD]]);
    expect(rows[0].evidence).toMatchObject({ kind: 'registered', method: 'deterministic', recordedBy: 'check:registered:ui.actions_match_state', bindingId: 'ui.actions_match_state' });
    expect(rows[0].evidence.bindingFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].evidence.evidenceRefs).toEqual([expect.stringMatching(new RegExp(`^${s.evidenceId}:[0-9a-f]{64}$`))]);
    expect(rows[0].evidence.captures).toEqual([{ artifactId: s.evidenceId, revision: 1, auditTaskId: s.auditId, captureSha: HEAD }]);
    // The model's provenance is kept and it stays a review, never a test result.
    expect(rows[1].evidence).toMatchObject({ method: 'model', recordedBy: 'registered:ui.card_clarity', decisionRecordIds: ['00000000-0000-4000-8000-00000000d001'] });
    // The governed outcome reads both rows (no kernel delivery here, so it has no PR head to call them current).
    const o = await outcome(s.builderId);
    expect(o.criteria.map((c) => [c.criterionId, c.verdict, c.source, c.headSha])).toEqual([['AC-1', 'pass', 'test', HEAD], ['AC-2', 'pass', 'review', HEAD]]);
  });

  test('AC-5: an identical deterministic request replays from storage; the model is called again; concurrent identical requests execute once', async () => {
    const s = await setup();
    const h = harness({ model: modelPass });
    await Promise.all([1, 2, 3].map(() => dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps)));
    expect(h.calls.filter((c) => c.id === 'ui.actions_match_state')).toHaveLength(1);
    const firstRows = (await verdictRows(s.builderId)).filter((r) => r.criterion_id === 'AC-1');
    expect(firstRows).toHaveLength(1);
    const again = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD, evidenceRef: s.evidenceId }, h.deps);
    expect(again.results.find((x) => x.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass', cached: true, recorded: true });
    expect(h.calls.filter((c) => c.id === 'ui.actions_match_state')).toHaveLength(1);
    // Nothing new to record: the stored run still stands.
    expect((await verdictRows(s.builderId)).filter((r) => r.criterion_id === 'AC-1')).toHaveLength(1);
    // Model judgments are never served from storage.
    expect(h.calls.filter((c) => c.id === 'ui.card_clarity').length).toBeGreaterThanOrEqual(2);
  });

  test('AC-5: the auditor re-capturing with changed runtime facts is evaluated again, and the new failure stands', async () => {
    const s = await setup();
    const h = harness({ model: modelPass });
    await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    // Same head, same words: only the captured state changed (a new revision of the same artifact).
    await q(sql`UPDATE artifacts SET content = ${JSON.stringify(offersMerge())} WHERE id = ${s.evidenceId}::uuid`);
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    expect(r.results.find((x) => x.criterionId === 'AC-1')).toMatchObject({ verdict: 'fail', cached: false, recorded: true });
    expect(h.calls.filter((c) => c.id === 'ui.actions_match_state')).toHaveLength(2);
    expect((await outcome(s.builderId)).criteria.find((c) => c.criterionId === 'AC-1')).toMatchObject({ verdict: 'fail', headSha: HEAD });
    // Restoring the earlier capture replays its stored pass as a new row instead of executing again.
    await q(sql`UPDATE artifacts SET content = ${JSON.stringify(capture())} WHERE id = ${s.evidenceId}::uuid`);
    const back = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    expect(back.results.find((x) => x.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass', cached: true, recorded: true });
    expect(h.calls.filter((c) => c.id === 'ui.actions_match_state')).toHaveLength(2);
    const ac1 = (await verdictRows(s.builderId)).filter((r) => r.criterion_id === 'AC-1');
    expect(ac1.map((r) => r.verdict)).toEqual(['pass', 'fail', 'pass']);
    expect(ac1[2].evidence.replayOf).toBe(ac1[0].id);
    expect((await outcome(s.builderId)).criteria.find((c) => c.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass' });
  });

  test('AC-2: a capture at a later commit counts only when it contains the PR head; a moved head leaves old results stale', async () => {
    const s = await setup({ content: capture({}, CAPTURED) });
    const ok = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, harness({ model: modelPass }).deps);
    expect(ok.results.find((x) => x.criterionId === 'AC-1')).toMatchObject({ verdict: 'pass', recorded: true });

    const t = await setup({ content: capture({}, ELSEWHERE) });
    const stale = await dispatchRegisteredVerification({ taskId: t.builderId, headSha: HEAD }, harness().deps);
    expect(stale.refused).toEqual([{ ref: t.evidenceId, reason: 'stale_capture' }]);
    expect(stale.results.every((x) => !x.recorded && x.verdict === 'inconclusive')).toBe(true);
    expect(await verdictRows(t.builderId)).toEqual([]);

    const unreachable = await dispatchRegisteredVerification({ taskId: t.builderId, headSha: HEAD }, harness({ contains: null }).deps);
    expect(unreachable.results.every((x) => !x.recorded)).toBe(true);

    // The PR moved on: the request for the old head is refused and nothing new is written.
    const moved = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, harness({ head: ELSEWHERE }).deps);
    expect(moved.reason).toContain('no longer current');
    expect((await outcome(s.builderId)).outcome).not.toBe('verified');
  });

  test('AC-2: the builder\'s own capture, an agent-filed audit, a person\'s edit and another workspace\'s capture are refused before any execution', async () => {
    const s = await setup();
    const h = harness({ model: modelPass });
    const own = await storeCapture(wsA, s.builderWorker, capture());
    const self = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD, evidenceRef: own }, h.deps);
    expect(self.refused).toEqual([{ ref: own, reason: expect.stringContaining('only a mission\'s [surface audit]') }]);

    const agentFiled = await setup({ auditCreatedByWorker: true });
    const filed = await dispatchRegisteredVerification({ taskId: agentFiled.builderId, headSha: HEAD }, h.deps);
    expect(filed.refused[0]?.reason).toContain('filed by an agent');

    const [other] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, task_class, role_slug) VALUES (${wsB}::uuid, ${`[surface audit] x ${rand()}`}, 'in_progress', 'work', 'visual-auditor') RETURNING id`);
    const foreign = await storeCapture(wsB, await worker(wsB, other.id), capture());
    const cross = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD, evidenceRef: foreign }, h.deps);
    expect(cross.refused).toEqual([{ ref: foreign, reason: 'cross_workspace' }]);

    const edited = await setup();
    await q(sql`UPDATE artifacts SET content = ${JSON.stringify(capture({ facts: { prState: 'open' } }))}, content_author = ${`user:${admin}`} WHERE id = ${edited.evidenceId}::uuid`);
    const human = await dispatchRegisteredVerification({ taskId: edited.builderId, headSha: HEAD }, h.deps);
    expect(human.refused).toEqual([{ ref: edited.evidenceId, reason: 'capture_not_written_by_audit_run' }]);

    const claimed = await setup({ content: { ...capture(), provenance: { ...capture().provenance, collector: 'agent' } } });
    const agent = await dispatchRegisteredVerification({ taskId: claimed.builderId, headSha: HEAD }, h.deps);
    expect(agent.refused).toEqual([{ ref: claimed.evidenceId, reason: 'collector_mismatch' }]);

    expect(h.calls).toEqual([]);
    for (const id of [s.builderId, agentFiled.builderId, edited.builderId, claimed.builderId]) expect(await verdictRows(id)).toEqual([]);
  });

  test('AC-2: a screenshot the capture cites must be one its own audit run uploaded', async () => {
    const s = await setup();
    const shot = crypto.randomUUID();
    await q(sql`INSERT INTO artifacts (id, workspace_id, worker_id, type, title, storage_key) VALUES (${shot}::uuid, ${wsA}::uuid, ${s.builderWorker}::uuid, 'screenshot', 'x', ${buildAuditScreenshotKey(wsA, shot, 'x.png')})`);
    await q(sql`UPDATE artifacts SET content = ${JSON.stringify({ ...capture(), capture: { ...capture().capture, screenshotRef: shot } })} WHERE id = ${s.evidenceId}::uuid`);
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, harness().deps);
    expect(r.refused).toEqual([{ ref: s.evidenceId, reason: 'foreign_screenshot' }]);
  });

  test('AC-4: provider and budget failures, missing evidence and a held reservation stay explicit and record nothing', async () => {
    const s = await setup();
    const budget = harness({ model: async () => { throw new Error('budget exhausted'); } });
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, budget.deps);
    expect(r.results.find((x) => x.criterionId === 'AC-2')).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('budget exhausted') });
    expect((await verdictRows(s.builderId)).map((x) => x.criterion_id)).toEqual(['AC-1']);
    expect((await outcome(s.builderId)).outcome).toBe('unverified');

    await q(sql`DELETE FROM artifacts WHERE id = ${s.evidenceId}::uuid`);
    const none = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, budget.deps);
    expect(none.results.every((x) => x.verdict === 'inconclusive' && !x.recorded)).toBe(true);

    // A run stuck inside the provider holds its reservation: an identical run does not execute.
    const t = await setup();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const stuck = harness({ model: async (id, input, scope) => { entered(); await gate; return modelPass(id, input, scope); } });
    const first = dispatchRegisteredVerification({ taskId: t.builderId, headSha: HEAD }, stuck.deps);
    await inside;
    const h = harness({ model: modelPass });
    const busy = await dispatchRegisteredVerification({ taskId: t.builderId, headSha: HEAD }, h.deps);
    expect(busy.results.find((x) => x.criterionId === 'AC-2')).toMatchObject({ recorded: false, reason: expect.stringContaining('already running') });
    expect(h.calls.filter((c) => c.id === 'ui.card_clarity')).toEqual([]);

    // The stuck run is abandoned (its lease lapses): the next run takes over, says so, and records.
    await q(sql`UPDATE system_cache SET expires_at = now() - interval '1 second' WHERE value->>'subject' = ${`task:${t.builderId}`}`);
    const recovered = await dispatchRegisteredVerification({ taskId: t.builderId, headSha: HEAD }, h.deps);
    expect(recovered.results.find((x) => x.criterionId === 'AC-2')).toMatchObject({ verdict: 'pass', recorded: true });
    const clarity = (await verdictRows(t.builderId)).filter((r) => r.criterion_id === 'AC-2');
    expect(clarity).toHaveLength(1);
    expect(clarity[0].evidence.recoveredReservation).toBe(true);
    // The abandoned run finishing late cannot record over the run that took its place.
    unblock();
    const late = await first;
    expect(late.results.find((x) => x.criterionId === 'AC-2')).toMatchObject({ recorded: false, reason: expect.stringContaining('reservation') });
    expect((await verdictRows(t.builderId)).filter((r) => r.criterion_id === 'AC-2')).toHaveLength(1);
    // Every reservation is released.
    expect(await q(sql`SELECT 1 FROM system_cache WHERE value->>'subject' = ${`task:${t.builderId}`}`)).toEqual([]);
  });

  test('R-4: the recorder refuses a row that does not match the immutable binding, its author or the current head', async () => {
    const s = await setup();
    const held = await harness().deps.load(s.builderId);
    if ('error' in held) throw new Error(held.error);
    const base = { specRevisionId: held.specRevisionId, criterionId: 'AC-1', verdict: 'pass' as const, headSha: HEAD, evidence: {} as Record<string, unknown> };
    const fp = (await import('@buildd/spec-contract/verification-bindings')).criterionVerifications(BODY)[0].fingerprint;
    const ok = { bindingFingerprint: fp, method: 'deterministic', recordedBy: 'check:registered:ui.actions_match_state' };
    expect(await recordRegisteredVerdict(s.builderId, { ...base, evidence: { ...ok, bindingFingerprint: 'f'.repeat(64) } }, async () => HEAD)).toMatchObject({ ok: false, status: 409 });
    expect(await recordRegisteredVerdict(s.builderId, { ...base, evidence: { ...ok, method: 'model' } }, async () => HEAD)).toMatchObject({ ok: false, status: 409 });
    expect(await recordRegisteredVerdict(s.builderId, { ...base, criterionId: 'AC-3', evidence: ok }, async () => HEAD)).toMatchObject({ ok: false });
    expect(await recordRegisteredVerdict(s.builderId, { ...base, evidence: ok }, async () => ELSEWHERE)).toMatchObject({ ok: false, status: 409 });
    expect(await recordRegisteredVerdict(s.builderId, { ...base, evidence: ok }, async () => HEAD)).toMatchObject({ ok: true });
  });

  test('R-7: a mission\'s final verification runs the same checks on the integrated target and records them through the mission recorder', async () => {
    const TARGET = 'e'.repeat(40);
    const n = Math.floor(Math.random() * 1e9);
    const [inst] = await q<{ id: string }>(sql`INSERT INTO github_installations (installation_id, account_type, account_login, account_id) VALUES (${n}, 'Organization', ${`o-${rand()}`}, ${n}) RETURNING id`);
    const [repo] = await q<{ id: string }>(sql`INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner) VALUES (${inst.id}::uuid, ${n}, ${`acme/card-${n}`}, ${`card-${n}`}, 'acme') RETURNING id`);
    const [ws] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, github_repo_id) VALUES (${`w-${rand()}`}, ${teamA}::uuid, ${repo.id}::uuid) RETURNING id`);
    const d = await createSpecDraft(user(), { workspaceId: ws.id, title: `Card ${rand()}`, body: BODY });
    if (!d.ok) throw new Error(d.error);
    const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
    if (!a.ok) throw new Error(a.error);
    const pinned = await pinSpecSource(ws.id, { specSource: { specId: d.spec.id } });
    if (!pinned.ok) throw new Error(pinned.error);
    const pin = (pinned.context as any).specSource;
    // AC-2 waived by a person: it is not run.
    const selection = { type: 'living_spec', specId: pin.specId, specRevisionId: pin.specRevisionId, revision: 1, contentHash: pin.contentHash,
      waived: [{ criterionId: 'AC-2', reason: 'copy reviewed by hand', by: 'user', at: '2026-10-21T00:00:00Z' }] };
    const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title, integration_branch_enabled, working_branch, goal_criteria)
      VALUES (${teamA}::uuid, ${ws.id}::uuid, ${`m-${rand()}`}, true, 'mission/card', ${JSON.stringify([selection])}::jsonb) RETURNING id`);
    const [final] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, creation_source, context)
      VALUES (${ws.id}::uuid, ${m.id}::uuid, 'Final verification', 'in_progress', 'work', 'orchestrator', ${JSON.stringify({ finalVerification: { missionId: m.id, specRevisionId: pin.specRevisionId } })}::jsonb) RETURNING id`);
    const [audit] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug)
      VALUES (${ws.id}::uuid, ${m.id}::uuid, ${`[surface audit] ${rand()}`}, 'in_progress', 'work', 'visual-auditor') RETURNING id`);
    const auditWorker = await worker(ws.id, audit.id);
    const githubApi = async (_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/mission%2Fcard') || path.endsWith('/git/ref/heads/mission/card')) return { object: { sha: TARGET } };
      throw new Error(`unexpected GitHub call ${path}`);
    };
    const calls: string[] = [];
    const deps = createRegisteredVerificationDeps({ githubApi, execute: async (id, input, scope) => { calls.push(id); return executeUiVerification(id, input, scope); } });

    // A capture of a constituent PR head is stale for the integrated target.
    const prShot = await storeCapture(ws.id, auditWorker, capture({}, HEAD));
    const stale = await dispatchRegisteredVerification({ taskId: final.id, headSha: TARGET }, deps);
    expect(stale.refused).toEqual([{ ref: prShot, reason: 'stale_capture' }]);
    expect(calls).toEqual([]);

    await storeCapture(ws.id, auditWorker, capture({}, TARGET));
    // A capture arriving from the mission's audit re-verifies the mission's final verification.
    expect(await subjectsForArrivedCaptures(audit.id)).toEqual([final.id]);
    const r = await dispatchRegisteredVerification({ taskId: final.id, headSha: TARGET }, deps);
    expect(r.results).toEqual([{ criterionId: 'AC-1', bindingId: 'ui.actions_match_state', verdict: 'pass', method: 'deterministic', cached: false, recorded: true }]);
    const rows = await q<{ mission_id: string; task_id: string | null; head_sha: string; evidence: any }>(sql`SELECT mission_id, task_id, head_sha, evidence FROM spec_outcome_verdicts WHERE mission_id = ${m.id}::uuid`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: null, head_sha: TARGET, evidence: { recordedBy: 'check:registered:ui.actions_match_state', method: 'deterministic' } });
    const { readMissionSpecOutcomes } = await import('../../src/lib/specs/mission-outcome');
    const read = await readMissionSpecOutcomes(null, m.id, githubApi);
    if (!read.ok) throw new Error(read.error);
    expect(read.outcomes[0].standing.standings.find((x) => x.criterionId === 'AC-1')).toMatchObject({ standing: 'pass', headSha: TARGET });
  });

  test('R-6/AC-5: an audit\'s captures arriving verify the task it reviews; a redelivered arrival records nothing new and asks no model again', async () => {
    const s = await setup();
    const h = harness({ model: modelPass });
    expect(await subjectsForArrivedCaptures(s.auditId)).toEqual([s.builderId]);
    // Not an audit: the builder's own report decides nothing for anyone.
    expect(await subjectsForArrivedCaptures(s.builderId)).toEqual([]);
    await rerunRegisteredVerificationForAudit(s.auditId, h.deps);
    const rows = await verdictRows(s.builderId);
    expect(rows.map((x) => [x.criterion_id, x.verdict])).toEqual([['AC-1', 'pass'], ['AC-2', 'pass']]);
    expect(rows[0].evidence.run.scenarios).toEqual(['closed-pr@mobile']);
    const calls = h.calls.length;
    await rerunRegisteredVerificationForAudit(s.auditId, h.deps);
    expect(h.calls).toHaveLength(calls);
    expect(await verdictRows(s.builderId)).toHaveLength(2);
  });

  test('R-16: a capture of a scenario the criterion does not declare certifies nothing', async () => {
    const other = capture();
    const s = await setup({ content: { ...other, subject: { ...other.subject, scenarioId: 'open-pr' } } });
    const h = harness({ model: modelPass });
    const r = await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD }, h.deps);
    expect(r.results.map((x) => [x.criterionId, x.verdict, x.recorded])).toEqual([['AC-1', 'inconclusive', false], ['AC-2', 'inconclusive', false]]);
    expect(r.results[0].reason).toContain('closed-pr@mobile');
    expect(h.calls).toEqual([]);
    expect(await verdictRows(s.builderId)).toEqual([]);
  });

  test('R-2: a revision with a verify that names no captures is never written', async () => {
    const r = await createSpecDraft(user(), { workspaceId: wsA, title: `Card ${rand()}`, body: `- AC-1: The card.\n  verify: ${JSON.stringify(STATE)}\n` });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'invalid_verification_declaration' });
  });

  test('R-18: a task token asking for verification is neither the subject nor filed under it', async () => {
    const s = await setup();
    const [fix] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, task_class, parent_task_id) VALUES (${wsA}::uuid, 'fix', 'pending', 'work', ${s.builderId}::uuid) RETURNING id`);
    expect(await verificationRequesterRefusal(s.builderId, s.builderId)).toContain('own outcome');
    expect(await verificationRequesterRefusal(fix.id, s.builderId)).toContain('filed under');
    expect(await verificationRequesterRefusal(s.auditId, s.builderId)).toBeNull();
  });

  test('auditor eligibility is the visual audit\'s rule, scoped to the subject', () => {
    const subject = { id: 's', title: 'build', workspaceId: 'w', missionId: 'm', roleSlug: null, dependsOn: [], parentTaskId: null, createdByWorkerId: null };
    const audit = { ...subject, id: 'a', title: '[surface audit] x', roleSlug: 'visual-auditor', dependsOn: ['s'] };
    expect(surfaceAuditorRefusal(audit, { kind: 'task', task: subject })).toBeNull();
    expect(surfaceAuditorRefusal({ ...audit, dependsOn: [] }, { kind: 'task', task: subject })).toContain('dependencies');
    expect(surfaceAuditorRefusal({ ...audit, dependsOn: [] }, { kind: 'mission', missionId: 'm', workspaceId: 'w', finalTaskId: 'f' })).toBeNull();
    expect(surfaceAuditorRefusal({ ...audit, missionId: 'other' }, { kind: 'mission', missionId: 'm', workspaceId: 'w', finalTaskId: 'f' })).toContain('mission');
    expect(surfaceAuditorRefusal({ ...audit, id: 'f' }, { kind: 'mission', missionId: 'm', workspaceId: 'w', finalTaskId: 'f' })).toContain('own work');
  });
});
