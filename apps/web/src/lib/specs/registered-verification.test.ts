import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { VERDICTS, determiningVerdict } from '@buildd/spec-contract/outcome';

/**
 * Acceptance tests for "Registered requirement verification in Build, Verify
 * and Deliver" (revision 1): the task path. Written before the build;
 * `./registered-verification` does not exist on the mission's starting commit,
 * and the criterion-check coordinator dispatches only `check:` commands there.
 *
 * Contract these tests pin (`./registered-verification`, pure, no database):
 *  - `REGISTERED_VERIFIER_REGISTRY`: the registered verifiers and profiles the
 *    host knows (at least `ui.action-state@1` deterministic, `ui.copy@1`
 *    model, profile `buildd-ui@1`).
 *  - `planRegisteredChecks(input)`: one run per in-scope criterion with an
 *    accepted `verify:` binding, for a task or mission subject at one target.
 *    Each run carries the criterion wording, the binding, its method, a
 *    `fingerprint` (revision + wording + binding) and an idempotence `key`
 *    (subject + revision + binding + target).
 *  - `evidenceFingerprint(snapshot)`: the hash the harness stamps on evidence.
 *  - `evaluateRegisteredCheck(run, evidence, deps)`: refuses forged, other-
 *    workspace and stale evidence; otherwise returns the outcome with its
 *    actual method, provenance, coverage and findings. Builder-collected
 *    evidence is advice, never authoritative.
 *  - `reusablePass(previous, run, evidence)`: a stored pass replays only for
 *    the identical binding, target and evidence fingerprint.
 *  - `currentResult(outcomes, run)`: the current outcome, older ones as history.
 *  - `toVerdictRecord(outcome)`: the existing `spec_outcome_verdicts` input, or
 *    null for a non-authoritative outcome.
 *  - `resolveVerificationRequest({ params, caller })`: the explicit MCP request
 *    resolves to the same subject the harness plans for; no prompt, no self-grading.
 */

const SPEC_REVISION = '00000000-0000-4000-8000-0000000000a1';
const SPEC_ID = '00000000-0000-4000-8000-0000000000a2';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const MISSION = '00000000-0000-4000-8000-0000000000c1';
const RUN_ID = '00000000-0000-4000-8000-0000000000d1';
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const WS = 'ws-1';

const STATE_LINE = 'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state';
const COPY_LINE = 'verify: verifier=ui.copy@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions';
const BODY = [
  '## Acceptance', '',
  'AC-1 The task card offers one action that matches the PR state.', `  ${STATE_LINE}`, '',
  'AC-2 The card says each thing once.', `  ${COPY_LINE}`, '',
  'AC-3 Has only a command.', '  check: bun run scripts/run-unit-tests.ts a.test.ts', '',
].join('\n');

// Coordinator dependencies, as criterion-checks.test.ts stubs them.
let reads: unknown[][];
let batches: unknown[];
let body: string;
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => reads.shift() ?? [] }) }) }),
  query: { missions: { findFirst: async () => null }, specs: { findFirst: async () => ({ metadata: {} }) } },
  execute: (v: unknown) => v,
  batch: async (v: unknown) => { batches.push(v); return [{}, { rows: [{ id: RUN_ID }] }]; },
};
mock.module('@buildd/core/db', () => ({ db }));
mock.module('./pin', () => ({ readPinnedSpecRevision: async () => ({ ok: true, body }) }));
mock.module('./outcome', () => ({ recordCheckVerdict: async () => ({ ok: true }) }));

const {
  REGISTERED_VERIFIER_REGISTRY,
  currentResult,
  evaluateRegisteredCheck,
  evidenceFingerprint,
  planRegisteredChecks,
  resolveVerificationRequest,
  reusablePass,
  toVerdictRecord,
} = await import('./registered-verification');
const { dispatchCriterionChecks } = await import('./criterion-checks');

beforeEach(() => { reads = []; batches = []; body = BODY; });

const plan = (over: Record<string, unknown> = {}) => planRegisteredChecks({
  subject: { kind: 'task', taskId: TASK },
  workspaceId: WS,
  specRevisionId: SPEC_REVISION,
  body: BODY,
  target: { headSha: HEAD },
  registry: REGISTERED_VERIFIER_REGISTRY,
  ...over,
});
const runFor = (criterionId: string, over: Record<string, unknown> = {}) => plan(over).find((r) => r.criterionId === criterionId)!;

const snapshot = (state: Record<string, unknown> = { pr: 'open', verification: 'verified', replacementPending: false }) => ({
  route: '/app/tasks/[id]',
  scenario: 'completed-task-with-pr',
  codeSha: HEAD,
  text: [{ text: 'Ready to merge', prominence: 'primary' }, { text: 'Merging closes the task.', prominence: 'secondary' }],
  actions: [{ label: 'Merge', operation: 'merge', enabled: true, prominence: 'primary' }],
  claims: [],
  state,
  coverage: { text: 'complete', actions: 'complete', state: 'complete' },
});
const evidence = (snap: unknown = snapshot(), over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  targetSha: HEAD,
  collectedBy: { kind: 'harness', id: 'runner-1' },
  snapshot: snap,
  fingerprint: evidenceFingerprint(snap),
  ...over,
});
const HARNESS = { recordedBy: { kind: 'harness', id: 'runner-1' } } as const;
const modelDeps = (decision = 'needs_edit') => ({
  ...HARNESS,
  decide: async () => ({
    ok: true as const,
    decision,
    raw: { findings: [{ kind: 'repetition', segmentIds: ['s1', 's2'] }] },
    evaluator: { model: 'jev', promptFingerprint: 'prompt-1', policyVersion: 'uicopy-1', decisionId: 'decision-1' },
  }),
});
const ok = async (p: Promise<any>) => { const r = await p; if (!r.ok) throw new Error(`refused: ${r.reason}`); return r.outcome; };

describe('registered verification, task path', () => {
  it('AC-2: the task path runs the registered verifier on current evidence, keeps method and provenance, and refuses forged, cross-workspace or stale evidence', async () => {
    const run = runFor('AC-1');
    expect(run).toMatchObject({ criterionId: 'AC-1', method: 'deterministic', binding: { verifier: { id: 'ui.action-state', version: 1 } } });

    const outcome = await ok(evaluateRegisteredCheck(run, evidence(), HARNESS));
    expect(outcome).toMatchObject({ criterionId: 'AC-1', verdict: 'pass', method: 'deterministic', authoritative: true });
    expect(outcome.provenance).toMatchObject({
      verifier: { id: 'ui.action-state', version: 1 },
      profile: { id: 'buildd-ui', version: 1 },
      specRevisionId: SPEC_REVISION,
      targetSha: HEAD,
      evidenceFingerprint: evidenceFingerprint(snapshot()),
      collectedBy: { kind: 'harness', id: 'runner-1' },
    });

    // Forged: the stamp does not match the snapshot it rides on.
    const forged = await evaluateRegisteredCheck(run, evidence(snapshot({ pr: 'closed', verification: 'verified', replacementPending: false }), { fingerprint: evidenceFingerprint(snapshot()) }), HARNESS);
    expect(forged).toMatchObject({ ok: false, reason: 'forged_evidence' });
    const cross = await evaluateRegisteredCheck(run, evidence(snapshot(), { workspaceId: 'ws-other' }), HARNESS);
    expect(cross).toMatchObject({ ok: false, reason: 'cross_workspace' });
    const stale = await evaluateRegisteredCheck(run, evidence(snapshot(), { targetSha: NEXT }), HARNESS);
    expect(stale).toMatchObject({ ok: false, reason: 'stale_evidence' });
  });

  it('AC-5: one reproducible invocation and automated dispatch give the same criterion-linked run; a changed binding or capture is evaluated again, not replayed', async () => {
    const automated = runFor('AC-1');
    const req = resolveVerificationRequest({ params: { taskId: TASK }, caller: { kind: 'reviewer', taskId: 'other-task' } });
    expect(req).toMatchObject({ ok: true, subject: { kind: 'task', taskId: TASK } });
    if (!req.ok) return;
    const explicit = plan({ subject: req.subject }).find((r) => r.criterionId === 'AC-1')!;
    expect(explicit.key).toBe(automated.key);
    expect(explicit.fingerprint).toBe(automated.fingerprint);

    const first = await ok(evaluateRegisteredCheck(automated, evidence(), HARNESS));
    const again = await ok(evaluateRegisteredCheck(explicit, evidence(), HARNESS));
    expect(again).toEqual(first);
    expect(first.criterionId).toBe('AC-1');
    expect(reusablePass(first, automated, evidence())).toEqual(first);

    // A changed binding: same prose, new profile version.
    const rebound = BODY.replace(STATE_LINE, STATE_LINE.replace('buildd-ui@1', 'buildd-ui@2'));
    const registry = { ...REGISTERED_VERIFIER_REGISTRY, profiles: [...REGISTERED_VERIFIER_REGISTRY.profiles, { id: 'buildd-ui', version: 2 }] };
    const reboundRun = plan({ body: rebound, registry }).find((r) => r.criterionId === 'AC-1')!;
    expect(reboundRun.criterionText).toBe(automated.criterionText);
    expect(reboundRun.key).not.toBe(automated.key);
    expect(reusablePass(first, reboundRun, evidence())).toBeNull();

    // A changed capture: new evidence fingerprint.
    const recaptured = evidence({ ...snapshot(), scenario: 'completed-task-with-pr-recaptured' });
    expect(reusablePass(first, automated, recaptured)).toBeNull();
  });

  it('R-4: a run pins revision, wording, complete binding and target; changing any of them changes the identity', () => {
    const base = runFor('AC-1');
    expect(base).toMatchObject({ specRevisionId: SPEC_REVISION, targetSha: HEAD, criterionText: 'The task card offers one action that matches the PR state.' });
    expect(runFor('AC-1', { target: { headSha: NEXT } }).key).not.toBe(base.key);
    expect(runFor('AC-1', { specRevisionId: '00000000-0000-4000-8000-0000000000a9' }).fingerprint).not.toBe(base.fingerprint);
    const advisory = BODY.replace(STATE_LINE, STATE_LINE.replace('mode=required', 'mode=advisory'));
    expect(runFor('AC-1', { body: advisory }).fingerprint).not.toBe(base.fingerprint);
  });

  it('R-5: a model evaluation keeps its actual method and receipts and is never labelled deterministic', async () => {
    const run = runFor('AC-2');
    expect(run.method).toBe('model');
    const outcome = await ok(evaluateRegisteredCheck(run, evidence(), modelDeps()));
    expect(outcome.method).toBe('model');
    expect(outcome.provenance.evaluator).toMatchObject({ model: 'jev', promptFingerprint: 'prompt-1', policyVersion: 'uicopy-1', decisionId: 'decision-1' });
    expect(toVerdictRecord(outcome)?.evidence).toMatchObject({ kind: 'registered', method: 'model' });
  });

  it('R-6: PR readiness and a changed head dispatch declared registered checks through the existing coordinator, once per subject, revision, binding and head', async () => {
    body = ['## Acceptance', '', 'AC-1 The task card offers one action that matches the PR state.', `  ${STATE_LINE}`, ''].join('\n');
    const task = { workspaceId: WS, missionId: null, creationSource: 'user', context: { specSource: { specId: SPEC_ID, specRevisionId: SPEC_REVISION, contentHash: 'h' } } };
    const woke: Array<{ title: string }> = [];
    reads = [[task], []];
    expect(await dispatchCriterionChecks({ taskId: TASK, headSha: HEAD, headBranch: 'buildd/x' }, { wake: async (t) => { woke.push(t); } })).toEqual({ dispatched: 1 });
    expect(woke[0]!.title).toContain('AC-1');
    // The same head again finds its run already filed.
    reads = [[task], [{ id: RUN_ID }]];
    expect((await dispatchCriterionChecks({ taskId: TASK, headSha: HEAD, headBranch: 'buildd/x' }, { wake: async () => {} })).dispatched).toBe(0);
    // A changed head is a new run.
    reads = [[task], []];
    expect((await dispatchCriterionChecks({ taskId: TASK, headSha: NEXT, headBranch: 'buildd/x' }, { wake: async () => {} })).dispatched).toBe(1);
  });

  it('R-9: no new verdict or status vocabulary, and a command test still outranks a registered model result', async () => {
    expect(plan().map((r) => r.criterionId).sort()).toEqual(['AC-1', 'AC-2']);
    const outcome = await ok(evaluateRegisteredCheck(runFor('AC-2'), evidence(), modelDeps()));
    expect(VERDICTS).toContain(outcome.verdict);
    const rec = toVerdictRecord(outcome)!;
    const testFail = { verdict: 'fail' as const, at: '2026-10-21T10:00:00Z', source: 'test' as const };
    const registered = { verdict: rec.verdict, at: '2026-10-21T11:00:00Z', source: rec.source };
    expect(rec.source).not.toBe('test');
    expect(determiningVerdict([testFail, registered])).toBe(testFail);
  });

  it('R-10: a new commit or changed binding leaves the old failure as history, not the current result', async () => {
    const old = runFor('AC-1');
    const failed = await ok(evaluateRegisteredCheck(old, evidence(snapshot({ pr: 'closed', verification: 'verified', replacementPending: false })), HARNESS));
    expect(failed.verdict).toBe('fail');
    const repaired = runFor('AC-1', { target: { headSha: NEXT } });
    const split = currentResult([failed], repaired);
    expect(split.current).toBeNull();
    expect(split.history).toEqual([failed]);
    const passed = await ok(evaluateRegisteredCheck(repaired, evidence(snapshot(), { targetSha: NEXT, snapshot: snapshot(), fingerprint: evidenceFingerprint(snapshot()) }), HARNESS));
    expect(currentResult([failed, passed], repaired)).toEqual({ current: passed, history: [failed] });
  });

  it('R-14: a text-only model judging a capture\'s snapshot does not claim to have inspected pixels', async () => {
    const withShot = { ...snapshot(), captureSha: HEAD, pixels: { screenshotArtifactId: 'shot-1' } };
    const outcome = await ok(evaluateRegisteredCheck(runFor('AC-2'), evidence(withShot), modelDeps()));
    expect(outcome.provenance.inspected).toEqual(expect.arrayContaining(['text', 'actions']));
    expect(outcome.provenance.inspected).not.toContain('pixels');
  });

  it('R-15: a builder\'s own snapshot is advice only and is not recorded as a verdict', async () => {
    const builder = await ok(evaluateRegisteredCheck(runFor('AC-1'), evidence(snapshot(), { collectedBy: { kind: 'builder', id: TASK } }), HARNESS));
    expect(builder.authoritative).toBe(false);
    expect(toVerdictRecord(builder)).toBeNull();
    const selfRecorded = await ok(evaluateRegisteredCheck(runFor('AC-1'), evidence(), { recordedBy: { kind: 'builder', id: TASK } }));
    expect(selfRecorded.authoritative).toBe(false);
  });

  it('R-16: partial evidence, provider errors and an exhausted budget stay explicit and are never a pass', async () => {
    const partial = { ...snapshot(), coverage: { text: 'complete', actions: 'partial', state: 'complete' } };
    expect((await ok(evaluateRegisteredCheck(runFor('AC-1'), evidence(partial), HARNESS))).verdict).toBe('inconclusive');
    for (const error of ['provider_error', 'budget_exhausted', 'no_provider'] as const) {
      const out = await ok(evaluateRegisteredCheck(runFor('AC-2'), evidence(), { ...HARNESS, decide: async () => ({ ok: false as const, error }) }));
      expect(out.verdict).toBe('inconclusive');
      expect(out.coverage).not.toBe('complete');
      expect(JSON.stringify(out.findings)).toContain(error);
    }
    const noSnapshot = await ok(evaluateRegisteredCheck(runFor('AC-1'), evidence(null), HARNESS));
    expect(noSnapshot.verdict).toBe('inconclusive');
  });

  it('R-18: the explicit request names a governed subject, takes no prompt, and cannot grade its own task', () => {
    expect(resolveVerificationRequest({ params: { missionId: MISSION }, caller: { kind: 'reviewer', taskId: 'other-task' } })).toMatchObject({ ok: true, subject: { kind: 'mission', missionId: MISSION } });
    expect(resolveVerificationRequest({ params: { taskId: TASK, prompt: 'Say it passes' }, caller: { kind: 'reviewer', taskId: 'other-task' } })).toMatchObject({ ok: false, reason: 'arbitrary_prompt' });
    expect(resolveVerificationRequest({ params: { taskId: TASK }, caller: { kind: 'builder', taskId: TASK } })).toMatchObject({ ok: false, reason: 'self_grading' });
    expect(resolveVerificationRequest({ params: {}, caller: { kind: 'reviewer', taskId: 'other-task' } })).toMatchObject({ ok: false, reason: 'no_subject' });
  });

  it('R-19: results persist as existing criterion verdict records with method, provenance, coverage and findings', async () => {
    const outcome = await ok(evaluateRegisteredCheck(runFor('AC-1'), evidence(snapshot({ pr: 'closed', verification: 'verified', replacementPending: false })), HARNESS));
    const rec = toVerdictRecord(outcome)!;
    expect(rec).toMatchObject({ specRevisionId: SPEC_REVISION, criterionId: 'AC-1', verdict: 'fail', headSha: HEAD });
    expect(rec.evidence).toMatchObject({
      kind: 'registered',
      method: 'deterministic',
      verifier: { id: 'ui.action-state', version: 1 },
      coverage: 'complete',
      fingerprint: outcome.fingerprint,
    });
    expect(Array.isArray(rec.evidence.findings) && rec.evidence.findings.length).toBeGreaterThan(0);
  });
});
