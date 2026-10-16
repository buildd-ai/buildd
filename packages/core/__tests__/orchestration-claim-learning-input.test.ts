import { expect, it } from 'bun:test';
import { assembleClaimLearningWorkspace } from '../orchestration-claim-learning-input';
const at = new Date('2026-01-01T00:00:00Z');
const decision: any = { id: 'd', taskId: 'task', workspaceId: 'workspace', decisionId: 'buildd.orchestration_claim_hold', fingerprint: 'fp', gate: 'soft_overlap', areaClass: 'other', applied: true, effective: 'START', suggested: 'START', confidence: .9, model: 'jev', createdAt: at, actor: 'jev_start', receipt: { coordination: { paths: ['src/shared.ts'], blockerTaskIds: ['holder'] } } };
const label: any = { decisionId: 'd', risk: { status: 'observed', value: false }, touched: { status: 'observed', value: { landed: true } } };
const input: any = { decisions: [decision], labels: [label], tasks: [], starts: [{ taskId: 'task', startedAt: new Date(at.getTime() + 1000) }], windowEnd: new Date(at.getTime() + 10000) };
it('never learns a later clean run from an applied decision whose claim did not start past the hold', () => {
  const assembled = assembleClaimLearningWorkspace(input, [], [], []);
  expect(assembled.outcomes[0].attributableUnsafe).toBeNull();
});
it('uses actual matching successful claims and keeps clean baseline separate', () => {
  const event: any = { id: 'start', taskId: 'task', workspaceId: 'workspace', occurredAt: new Date(at.getTime() + 1000), reason: 'claim_learning_jev_start', detail: { gate: 'soft_overlap', blockerTaskIds: ['holder'], paths: ['src/shared.ts'], fingerprint: 'fp' } };
  const result = assembleClaimLearningWorkspace(input, [event], [], [{ ...label, attributableUnsafe: false }]);
  expect(result.outcomes[0]).toMatchObject({ actor: 'jev_start', attributableUnsafe: false, waitMs: 1000 });
  expect(result.outcomes.some(r => r.actor === 'rule_start_clean')).toBe(false);
  expect(assembleClaimLearningWorkspace({...input, decisions:[{...decision,attributableUnsafe:false}]}, [event], [], [{...label,attributableUnsafe:null}]).outcomes[0].attributableUnsafe).toBeNull();
});
it('a human safe force only becomes false-hold candidate with the same blocker evidence', () => {
  const hold = { ...decision, applied: false, effective: 'HOLD', suggested: 'HOLD', actor: 'jev_hold' };
  const human = { ...decision, id: 'human', decisionId: 'buildd.human_force_start', actor: 'human_force', createdAt: new Date(at.getTime() + 2000) };
  const l = { ...label, decisionId: 'human', attributableUnsafe: false };
  const result = assembleClaimLearningWorkspace({ ...input, decisions: [hold, human], labels: [l] }, [], [], [l]);
  expect(result.outcomes.find(r => r.actor === 'human_force')?.matchedJevLabel).toBe('HOLD');
  const unrelated = { ...human, receipt: { coordination: { paths: ['src/shared.ts'], blockerTaskIds: ['other'] } } };
  expect(assembleClaimLearningWorkspace({ ...input, decisions: [hold, unrelated], labels: [l] }, [], [], [l]).outcomes.find(r => r.actor === 'human_force')?.matchedJevLabel).toBeUndefined();
});
it('recognizes an eligible scope-undeclared advisory start by its blocker and state digest', () => {
  const advisory = {...decision,gate:'advisory_manifest',areaClass:'unknown',candidateDigest:'state',receipt:{coordination:{paths:[],blockerTaskIds:['holder']}}};
  const event: any = {id:'start',taskId:'task',workspaceId:'workspace',occurredAt:new Date(at.getTime()+1000),reason:'claim_learning_jev_start',detail:{gate:'advisory_manifest',paths:[],blockerTaskIds:['holder'],fingerprint:'fp',candidateDigest:'state'}};
  const result=assembleClaimLearningWorkspace({...input,decisions:[advisory]},[event],[],[{...label,attributableUnsafe:false}]);
  expect(result.outcomes[0].attributableUnsafe).toBe(false);
});
