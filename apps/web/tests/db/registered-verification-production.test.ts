/**
 * Registered `verify:` checks end to end on real Postgres, through the
 * production engine only: a canonical (key=value) spec written, approved and
 * pinned through the real store; a capture owned by an independent, platform-
 * filed [surface audit] run; the production entry point a capture arrival
 * takes (rerunRegisteredVerificationForAudit) with the production store and
 * executor; then the governed standing read back. The model is stubbed at the
 * decision broker's boundary only (access, the provider call, measurements):
 * the evaluator, the broker, the decision ledger write and the verdict
 * recorders are the real ones, and the PR head is the kernel delivery's.
 * GitHub (ancestry, the mission branch ref) is injected because there is none here.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';
import type { SurfaceEvidence } from '@buildd/core/ui-verification';
import type { UiVerificationDeps } from '../../src/lib/specs/ui-verification-decision';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { readGovernedOutcome } = await import('../../src/lib/specs/outcome');
const { readMissionSpecOutcomes } = await import('../../src/lib/specs/mission-outcome');
const { dispatchRegisteredVerification } = await import('../../src/lib/specs/registered-verification');
const { createRegisteredVerificationDeps, rerunRegisteredVerificationForAudit } = await import('../../src/lib/specs/registered-verification-store');
const { executeUiVerification } = await import('../../src/lib/specs/ui-verification-decision');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD = 'a'.repeat(40);
const ELSEWHERE = 'd'.repeat(40);
const TARGET = 'e'.repeat(40);
const STATE_LINE = 'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state';
const COPY_LINE = 'verify: verifier=ui.copy@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions';
const AC2_WORDS = 'The card says each thing once.';
const BODY = [
  '# Task card',
  '- AC-1: The card offers only actions the PR state allows.',
  `  ${STATE_LINE}`,
  '  scenarios: closed-pr@mobile',
  `- AC-2: ${AC2_WORDS}`,
  `  ${COPY_LINE}`,
  '  scenarios: closed-pr@mobile',
  '',
].join('\n');

let teamA: string; let wsA: string; let wsB: string; let missionId: string; let admin: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  ({ workspaceId: wsB } = await seedWorkspace());
  missionId = await seedMission(teamA, wsA);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
});
const user = () => ({ kind: 'user' as const, userId: admin });

/** A closed PR whose card still offers Merge, with two copy blocks that say the same thing. */
const capture = (sha = HEAD, over: Partial<SurfaceEvidence> = {}): SurfaceEvidence => ({
  schemaVersion: 1,
  subject: { commitSha: sha, route: '/app/tasks/example', scenarioId: 'closed-pr', viewport: 'mobile' },
  capture: { captureId: `capture-${rand()}`, capturedAt: '2026-10-21T12:00:00.000Z', snapshotRef: 'snapshot-1' },
  visible: {
    blocks: [
      { id: 'pr-status', role: 'status', text: 'Pull request closed', order: 0, disclosure: 'visible' },
      { id: 'pr-status-again', role: 'body', text: 'This pull request is closed.', order: 1, disclosure: 'visible' },
      { id: 'reopen-hint', role: 'recovery', text: 'Reopen the pull request to merge it.', order: 2, disclosure: 'visible' },
    ],
    actions: [{ id: 'merge-button', label: 'Merge', operation: 'merge_pr', enabled: true, prominence: 'primary', disclosure: 'visible' }],
  },
  facts: { prState: 'closed', replacementState: 'none', verificationState: 'failed', shownVerificationState: 'failed' },
  provenance: { collector: 'visual_auditor', collectorVersion: '1', reportedVia: 'runner', factVersion: '1' },
  coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'absent' },
  ...over,
});

async function worker(workspaceId: string, taskId: string) {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status) VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', ${`w-${rand()}`}, 'running') RETURNING id`);
  return w.id;
}
async function storeCapture(workspaceId: string, workerId: string, content: unknown) {
  const [a] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, worker_id, type, title, content) VALUES (${workspaceId}::uuid, ${workerId}::uuid, 'data', 'surface capture', ${JSON.stringify(content)}) RETURNING id`);
  return a.id;
}

/** The canonical spec approved and pinned; a builder task; a platform-filed audit reviewing it, with its own capture. */
async function setup(content: unknown = capture()) {
  const d = await createSpecDraft(user(), { workspaceId: wsA, title: `Card ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  const pinned = await pinSpecSource(wsA, { specSource: { specId: d.spec.id } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [builder] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, context)
    VALUES (${wsA}::uuid, ${missionId}::uuid, ${`build card ${rand()}`}, 'completed', 'work', ${JSON.stringify(pinned.context)}::jsonb) RETURNING id`);
  // The kernel's delivery of the builder's PR: where the real PR-head lookup reads the head.
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha)
    VALUES (${wsA}::uuid, ${builder.id}::uuid, 'OPEN', 'kernel', ${HEAD})`);
  const builderWorker = await worker(wsA, builder.id);
  const [audit] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, task_class, role_slug, depends_on, context)
    VALUES (${wsA}::uuid, ${missionId}::uuid, ${`[surface audit] card ${rand()}`}, 'in_progress', 'work', 'visual-auditor',
      ${JSON.stringify([builder.id])}::jsonb, '{"surfaceAuditTrigger":"auto"}'::jsonb) RETURNING id`);
  const auditWorker = await worker(wsA, audit.id);
  const evidenceId = await storeCapture(wsA, auditWorker, content);
  return { builderId: builder.id, builderWorker, auditId: audit.id, auditWorker, evidenceId };
}

/**
 * The broker's outside edge: team access, the provider call and measurements. Everything inside it (the kind,
 * the gate, the ledger row) is production. `choices` are the three axes' answers.
 */
function broker(opts: { choices?: string[]; fail?: 'throw' | 'ledger' } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const deps: UiVerificationDeps = {
    measurements: async () => [],
    resolveAccess: async () => ({ ok: true, apiKey: 'fake-key', model: 'typesafe/jev-3' }) as never,
    call: (async (params: Record<string, unknown>) => {
      calls.push(params);
      if (opts.fail === 'throw') throw new Error('provider unreachable');
      const choices = opts.choices ?? ['clear', 'clear', 'clear'];
      return { ok: true, answers: Object.fromEntries(['repetition', 'action_clarity', 'workflow_narration'].map((name, i) => [name, { type: 'choice', choice: choices[i], confidence: 0.97, probabilities: { [choices[i]!]: 0.97 } }])), model: 'typesafe/jev-3', usage: { inputTokens: 60, outputTokens: 3, costUsd: 0.0001 }, latencyMs: 9, attempts: 1 };
    }) as never,
    ...(opts.fail === 'ledger' ? { record: async () => null } : {}),
  };
  return { deps, calls };
}

function production(b = broker(), over: { contains?: boolean; githubApi?: (i: number, path: string) => Promise<unknown> } = {}) {
  return createRegisteredVerificationDeps({
    repo: async () => ({ fullName: 'acme/shop', installationId: 1 }),
    contains: async () => over.contains ?? false,
    execute: (id, input, scope, ctx) => executeUiVerification(id, input, scope, ctx, b.deps),
    ...(over.githubApi ? { githubApi: over.githubApi as never } : {}),
  });
}

const verdictRows = async (taskId: string) => q<{ id: string; criterion_id: string; verdict: string; evidence: any }>(
  sql`SELECT id, criterion_id, verdict, evidence FROM spec_outcome_verdicts WHERE task_id = ${taskId}::uuid ORDER BY created_at`);
const outcome = async (taskId: string) => {
  const r = await readGovernedOutcome(user(), taskId);
  if (!r.ok) throw new Error(r.error);
  return r.outcome;
};

describe('registered verification through the production engine, task path', () => {
  test('a capture arrival judges the independent capture: DOM-linked findings, a persisted model decision, inspected capabilities, review standing', async () => {
    const s = await setup();
    const b = broker({ choices: ['revise', 'clear', 'clear'] });
    await rerunRegisteredVerificationForAudit(s.auditId, production(b));

    const rows = await verdictRows(s.builderId);
    expect(rows.map((r) => [r.criterion_id, r.verdict])).toEqual([['AC-1', 'fail'], ['AC-2', 'fail']]);
    const [state, copy] = rows;

    // Deterministic: the closed PR's Merge button, by its own element id; a review with its real method.
    expect(state!.evidence).toMatchObject({
      kind: 'registered', method: 'deterministic', recordedBy: 'registered:ui.actions_match_state',
      verifier: { id: 'ui.action-state', version: 1 }, profile: { id: 'buildd-ui', version: 1 },
      coverage: 'complete', inspected: ['text', 'actions', 'state'],
      captures: [{ artifactId: s.evidenceId, revision: 1, auditTaskId: s.auditId, captureSha: HEAD }],
    });
    expect(state!.evidence.findings).toEqual([expect.objectContaining({ kind: 'action_state_contradiction', code: 'terminal_pr_offers_merge', actionIds: ['merge-button'], ref: expect.stringContaining(s.evidenceId) })]);

    // Model: one broker call, which saw the capture's ids, its runtime facts and the criterion's words.
    expect(b.calls).toHaveLength(1);
    const sent = JSON.stringify(b.calls[0]);
    for (const part of [AC2_WORDS, '"pr-status-again"', '"merge-button"', 'prState', '"recovery"']) expect(sent).toContain(part);
    expect(copy!.evidence).toMatchObject({ kind: 'registered', method: 'model', recordedBy: 'registered:ui.card_clarity', coverage: 'complete', inspected: ['text', 'actions', 'state'] });
    expect(copy!.evidence.inspected).not.toContain('pixels');
    // The finding names the capture's own blocks; the material recovery step is never reported dispensable.
    expect(copy!.evidence.findings).toEqual([expect.objectContaining({ kind: 'repetition', segmentIds: ['pr-status', 'pr-status-again'] })]);

    // Ledger provenance: the decision record the verdict cites exists, for this team, kind and policy.
    const ids: string[] = copy!.evidence.decisionRecordIds;
    expect(ids).toHaveLength(1);
    expect(copy!.evidence.evaluator).toMatchObject({ decisionId: ids[0], policyVersion: 'ui-copy-v4', model: 'typesafe/jev-3' });
    const [ledger] = await q<{ team_id: string; capability: string; policy_version: string; status: string }>(
      sql`SELECT team_id, capability, policy_version, status FROM decision_records WHERE id = ${ids[0]}::uuid`);
    expect(ledger).toMatchObject({ team_id: teamA, capability: 'buildd.ui_copy', policy_version: 'ui-copy-v4', status: 'applied' });

    // Governed standing: both fail, both reviews (a registered result is never a test result).
    const o = await outcome(s.builderId);
    expect(o.outcome).toBe('fail');
    expect(o.criteria.map((c) => [c.criterionId, c.verdict, c.source])).toEqual([['AC-1', 'fail', 'review'], ['AC-2', 'fail', 'review']]);
  });

  test('copy needs only text and actions: a capture with no runtime facts is still judged, and inspected says so', async () => {
    const bare = capture(HEAD, { facts: {}, provenance: { collector: 'visual_auditor', collectorVersion: '1', reportedVia: 'runner', factVersion: 'none' }, coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'absent', screenshot: 'absent' } });
    const s = await setup(bare);
    const b = broker();
    await rerunRegisteredVerificationForAudit(s.auditId, production(b));
    const rows = await verdictRows(s.builderId);
    // The action check cannot judge without facts (inconclusive, recorded as such); the copy check passes on what it saw.
    expect(rows.map((r) => [r.criterion_id, r.verdict])).toEqual([['AC-1', 'inconclusive'], ['AC-2', 'pass']]);
    expect(rows[1]!.evidence).toMatchObject({ method: 'model', inspected: ['text', 'actions'] });
    expect(b.calls).toHaveLength(1);
    expect((await outcome(s.builderId)).outcome).toBe('unverified');
  });

  test('missing scenarios, stale, foreign and builder evidence never certify anything and never reach the model', async () => {
    const b = broker();
    const undeclared = await setup(capture(HEAD, { subject: { commitSha: HEAD, route: '/app/tasks/example', scenarioId: 'open-pr', viewport: 'mobile' } }));
    await rerunRegisteredVerificationForAudit(undeclared.auditId, production(b));
    expect(await verdictRows(undeclared.builderId)).toEqual([]);

    const stale = await setup(capture(ELSEWHERE));
    const r = await dispatchRegisteredVerification({ taskId: stale.builderId, headSha: HEAD }, production(b));
    expect(r.refused).toEqual([{ ref: stale.evidenceId, reason: 'stale_capture' }]);
    expect(await verdictRows(stale.builderId)).toEqual([]);

    const s = await setup();
    const [other] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, task_class, role_slug) VALUES (${wsB}::uuid, ${`[surface audit] x ${rand()}`}, 'in_progress', 'work', 'visual-auditor') RETURNING id`);
    const foreign = await storeCapture(wsB, await worker(wsB, other.id), capture());
    expect((await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD, evidenceRef: foreign }, production(b))).refused).toEqual([{ ref: foreign, reason: 'cross_workspace' }]);
    // Advice: the builder's own capture is refused outright.
    const own = await storeCapture(wsA, s.builderWorker, capture());
    expect((await dispatchRegisteredVerification({ taskId: s.builderId, headSha: HEAD, evidenceRef: own }, production(b))).refused[0]?.reason).toContain('only a mission\'s [surface audit]');
    expect(await verdictRows(s.builderId)).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test('provider failure, a lost ledger row and a failing command check never stand as a pass', async () => {
    const s = await setup(capture(HEAD, { visible: { ...capture().visible, actions: [] } }));
    await rerunRegisteredVerificationForAudit(s.auditId, production(broker({ fail: 'throw' })));
    await rerunRegisteredVerificationForAudit(s.auditId, production(broker({ fail: 'ledger' })));
    // Only the deterministic pass is recorded: neither model attempt produced a result.
    expect((await verdictRows(s.builderId)).map((r) => [r.criterion_id, r.verdict, r.evidence.method])).toEqual([['AC-1', 'pass', 'deterministic']]);

    await rerunRegisteredVerificationForAudit(s.auditId, production(broker()));
    expect((await outcome(s.builderId)).outcome).toBe('verified');
    // A failing command check on the same criterion still decides it: the registered pass cannot hide it.
    await q(sql`INSERT INTO spec_outcome_verdicts (workspace_id, task_id, spec_revision_id, criterion_id, verdict, head_sha, evidence)
      SELECT workspace_id, task_id, spec_revision_id, 'AC-2', 'fail', ${HEAD}, ${JSON.stringify({ recordedBy: `check:${s.builderId}`, observed: 'exit 1' })}::jsonb
      FROM spec_outcome_verdicts WHERE task_id = ${s.builderId}::uuid LIMIT 1`);
    expect((await outcome(s.builderId)).outcome).toBe('fail');
  });
});

describe('registered verification through the production engine, mission path', () => {
  test('a mission audit\'s capture of the integrated target is judged and folds with its real method, as a review', async () => {
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
    const selection = { type: 'living_spec', specId: pin.specId, specRevisionId: pin.specRevisionId, revision: 1, contentHash: pin.contentHash };
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
    const read = async () => {
      const r = await readMissionSpecOutcomes(null, m.id, githubApi);
      if (!r.ok) throw new Error(r.error);
      return r.outcomes[0]!.standing;
    };

    // A capture of a constituent PR head is not the integrated target: nothing is judged.
    const b = broker();
    await storeCapture(ws.id, auditWorker, capture(HEAD));
    await rerunRegisteredVerificationForAudit(audit.id, production(b, { githubApi }));
    expect(b.calls).toEqual([]);
    expect((await read()).verdict).toBe('UNVERIFIED');

    // The audit captures the integrated target: a truthful card with copy the model finds clear.
    await storeCapture(ws.id, auditWorker, capture(TARGET, { visible: { ...capture().visible, actions: [] } }));
    await rerunRegisteredVerificationForAudit(audit.id, production(b, { githubApi }));
    expect(b.calls).toHaveLength(1);
    const rows = await q<{ criterion_id: string; task_id: string | null; evidence: any }>(sql`SELECT criterion_id, task_id, evidence FROM spec_outcome_verdicts WHERE mission_id = ${m.id}::uuid ORDER BY created_at`);
    expect(rows.map((r) => [r.criterion_id, r.task_id, r.evidence.method, r.evidence.recordedBy])).toEqual([
      ['AC-1', null, 'deterministic', 'registered:ui.actions_match_state'],
      ['AC-2', null, 'model', 'registered:ui.card_clarity'],
    ]);
    const [ledger] = await q<{ mission_id: string | null }>(sql`SELECT mission_id FROM decision_records WHERE id = ${rows[1]!.evidence.decisionRecordIds[0]}::uuid`);
    expect(ledger?.mission_id).toBe(m.id);

    const standing = await read();
    expect(standing.verdict).toBe('pass');
    expect(standing.standings.map((x) => [x.criterionId, x.standing, x.source, x.method])).toEqual([
      ['AC-1', 'pass', 'review', 'deterministic'],
      ['AC-2', 'pass', 'review', 'model'],
    ]);
  });
});
