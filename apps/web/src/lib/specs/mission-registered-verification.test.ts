import { describe, expect, it } from 'bun:test';
import { foldMissionSpec, type MissionTarget, type MissionVerdictRow } from './mission-outcome-fold';
import { REGISTERED_VERIFIER_REGISTRY, evaluateRegisteredCheck, evidenceFingerprint, planRegisteredChecks } from './registered-verification';
import { missionRegisteredChecks, registeredMissionRow, requiredRegisteredCriteria } from './mission-registered-verification';

/**
 * Acceptance tests for "Registered requirement verification in Build, Verify
 * and Deliver" (revision 1): the mission path. Written before the build;
 * `./mission-registered-verification` and `./registered-verification` do not
 * exist on the mission's starting commit.
 *
 * Contract these tests pin:
 *  - `missionRegisteredChecks(input)` plans the selected outcome spec's
 *    registered checks against the mission's integrated target, through the
 *    same planner the task path uses; with no integrated target it plans none
 *    and says why.
 *  - `requiredRegisteredCriteria(body, registry, scope)` lists the in-scope
 *    criteria whose binding is `mode=required`.
 *  - `registeredMissionRow(id, outcome)` is the outcome as a mission verdict
 *    row, carrying its real `method` (deterministic | model | visual).
 *  - `foldMissionSpec` takes `required` criteria: a required registered check
 *    stays in the completion decision whatever its method, its standing
 *    carries that method, and fail / missing / stale / inconclusive /
 *    unsupported keep the mission from passing.
 */

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PR_HEAD = 'e'.repeat(40);
const WS = 'ws-1';
const SPEC_REVISION = '00000000-0000-4000-8000-0000000000a1';
const MISSION = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const integration = (headSha = A): MissionTarget => ({ kind: 'integration', headSha, branch: 'mission/x' });

const STATE_LINE = 'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state';
const COPY_LINE = 'verify: verifier=ui.copy@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions';
const ADVICE_LINE = 'verify: verifier=ui.copy@1 profile=buildd-ui@1 mode=advisory evidence=ui.text,ui.actions';
const BODY = [
  '## Acceptance', '',
  'AC-1 The task card offers one action that matches the PR state.', `  ${STATE_LINE}`, '',
  'AC-2 The card says each thing once.', `  ${COPY_LINE}`, '',
  'AC-3 Has an acceptance test.', '',
  'AC-4 Copy advice only.', `  ${ADVICE_LINE}`, '',
].join('\n');

const snapshot = () => ({
  route: '/app/tasks/[id]', scenario: 'completed-task-with-pr', codeSha: A,
  text: [{ text: 'Ready to merge', prominence: 'primary' }],
  actions: [{ label: 'Merge', operation: 'merge', enabled: true, prominence: 'primary' }],
  claims: [], state: { pr: 'open', verification: 'verified', replacementPending: false },
  coverage: { text: 'complete', actions: 'complete', state: 'complete' },
});
const evidence = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS, targetSha: A, collectedBy: { kind: 'harness', id: 'runner-1' },
  snapshot: snapshot(), fingerprint: evidenceFingerprint(snapshot()), ...over,
});
const HARNESS = { recordedBy: { kind: 'harness', id: 'runner-1' } } as const;

const plan = (target: MissionTarget = integration()) => missionRegisteredChecks({
  missionId: MISSION, workspaceId: WS,
  selection: { specRevisionId: SPEC_REVISION, criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], waived: [] },
  body: BODY, target, registry: REGISTERED_VERIFIER_REGISTRY,
});

let n = 0;
const at = () => `2026-10-21T10:${String(10 + (n++ % 50)).padStart(2, '0')}:00Z`;
const testRow = (criterionId: string, verdict: MissionVerdictRow['verdict'], headSha = A): MissionVerdictRow =>
  ({ id: `t${n}`, criterionId, verdict, headSha, at: at(), source: 'test' });
const regRow = (criterionId: string, verdict: MissionVerdictRow['verdict'], method: 'deterministic' | 'model' | 'visual', headSha = A) =>
  ({ id: `r${n}`, criterionId, verdict, headSha, at: at(), source: 'review', method }) as MissionVerdictRow;
const fold = (rows: MissionVerdictRow[], target: MissionTarget = integration()) =>
  foldMissionSpec({ scope: ['AC-2', 'AC-3'], waived: [], rows, target, required: ['AC-2'] } as Parameters<typeof foldMissionSpec>[0]);

describe('registered verification, mission path', () => {
  it('AC-2: the integrated mission path runs the same registered verifier as the task path on current evidence and refuses forged, cross-workspace or stale evidence', async () => {
    const p = plan();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const mission = p.runs.find((r) => r.criterionId === 'AC-1')!;
    const task = planRegisteredChecks({ subject: { kind: 'task', taskId: TASK }, workspaceId: WS, specRevisionId: SPEC_REVISION, body: BODY, target: { headSha: PR_HEAD }, registry: REGISTERED_VERIFIER_REGISTRY })
      .find((r) => r.criterionId === 'AC-1')!;
    expect(mission.binding).toEqual(task.binding);
    expect(mission.fingerprint).toBe(task.fingerprint);
    expect(mission.subject).toEqual({ kind: 'mission', missionId: MISSION });
    expect(mission.targetSha).toBe(A);

    const r = await evaluateRegisteredCheck(mission, evidence(), HARNESS);
    expect(r).toMatchObject({ ok: true, outcome: { criterionId: 'AC-1', verdict: 'pass', method: 'deterministic', provenance: { targetSha: A, verifier: { id: 'ui.action-state', version: 1 } } } });

    // Evidence captured on a constituent PR head is stale for the integrated target.
    expect(await evaluateRegisteredCheck(mission, evidence({ targetSha: PR_HEAD }), HARNESS)).toMatchObject({ ok: false, reason: 'stale_evidence' });
    expect(await evaluateRegisteredCheck(mission, evidence({ workspaceId: 'ws-other' }), HARNESS)).toMatchObject({ ok: false, reason: 'cross_workspace' });
    expect(await evaluateRegisteredCheck(mission, evidence({ fingerprint: 'f'.repeat(64) }), HARNESS)).toMatchObject({ ok: false, reason: 'forged_evidence' });
  });

  it('AC-4: a required model check stays required without being labelled deterministic, and missing or incomplete required verification cannot pass the mission', () => {
    expect(requiredRegisteredCriteria(BODY, REGISTERED_VERIFIER_REGISTRY, ['AC-1', 'AC-2', 'AC-3', 'AC-4'])).toEqual(['AC-1', 'AC-2']);

    const passing = fold([testRow('AC-3', 'pass'), regRow('AC-2', 'pass', 'model')]);
    expect(passing.verdict).toBe('pass');
    const standing = passing.standings.find((s) => s.criterionId === 'AC-2') as Record<string, unknown>;
    expect(standing.method).toBe('model');
    expect(standing.source).not.toBe('test');
    expect(standing.method).not.toBe('deterministic');

    expect(fold([testRow('AC-3', 'pass')]).verdict).toBe('UNVERIFIED');
    expect(fold([testRow('AC-3', 'pass'), regRow('AC-2', 'fail', 'model')]).verdict).toBe('fail');
    for (const v of ['inconclusive', 'unsupported'] as const) {
      expect(fold([testRow('AC-3', 'pass'), regRow('AC-2', v, 'model')]).verdict).toBe('UNVERIFIED');
    }
    expect(fold([testRow('AC-3', 'pass'), regRow('AC-2', 'pass', 'model', B)]).verdict).toBe('UNVERIFIED');
  });

  it('R-7: the mission verifies its integrated target, not its PRs, and plans nothing without one', () => {
    const p = plan();
    expect(p.ok && p.runs.map((r) => r.criterionId).sort()).toEqual(['AC-1', 'AC-2', 'AC-4']);
    expect(p.ok && p.runs.every((r) => r.targetSha === A)).toBe(true);
    const none = plan({ kind: 'unknown', reason: 'the mission branch has no head' });
    expect(none).toMatchObject({ ok: false });
    // Passing PR reviews do not stand in for the integrated check.
    const prReviewsOnly = fold([testRow('AC-3', 'pass'), regRow('AC-2', 'pass', 'model', PR_HEAD)]);
    expect(prReviewsOnly.verdict).toBe('UNVERIFIED');
  });

  it('R-8: a required registered check stays in the completion fold whatever its method', () => {
    for (const method of ['deterministic', 'model', 'visual'] as const) {
      expect(fold([testRow('AC-3', 'pass'), regRow('AC-2', 'fail', method)]).verdict).toBe('fail');
      expect(fold([testRow('AC-3', 'pass'), regRow('AC-2', 'inconclusive', method)]).verdict).toBe('UNVERIFIED');
      const s = fold([testRow('AC-3', 'pass'), regRow('AC-2', 'unsupported', method)]).standings.find((x) => x.criterionId === 'AC-2') as Record<string, unknown>;
      expect(s).toMatchObject({ standing: 'unsupported', method });
    }
    expect(fold([testRow('AC-3', 'pass')]).standings.find((s) => s.criterionId === 'AC-2')?.standing).toBe('missing');
  });

  it('R-9: a mission verdict row from a registered outcome keeps the existing vocabulary and a test result still decides its criterion', async () => {
    const p = plan();
    if (!p.ok) throw new Error('no plan');
    const r = await evaluateRegisteredCheck(p.runs.find((x) => x.criterionId === 'AC-1')!, evidence(), HARNESS);
    if (!r.ok) throw new Error(r.reason);
    const row = registeredMissionRow('v1', r.outcome);
    expect(row).toMatchObject({ id: 'v1', criterionId: 'AC-1', verdict: 'pass', headSha: A, source: 'review', method: 'deterministic' });
    const folded = foldMissionSpec({ scope: ['AC-1'], waived: [], rows: [{ ...row, at: '2026-10-21T12:00:00Z' }, { ...testRow('AC-1', 'fail'), at: '2026-10-21T11:00:00Z' }], target: integration(), required: ['AC-1'] } as Parameters<typeof foldMissionSpec>[0]);
    expect(folded.verdict).toBe('fail');
  });
});
