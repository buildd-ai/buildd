import { describe, expect, test } from 'bun:test';
import { agentCredential, evidenceForCompletion, isRunnerReported, keepStoredEvidence, stampEvidence } from './verification-provenance';

const ok = { workerId: 'w-1', iteration: 0, conditionType: 'command', exitCode: 0, outcome: 'ok' };

describe('stampEvidence', () => {
  test('the server, not the caller, says how the evidence arrived', () => {
    expect(stampEvidence({ ...ok, reportedVia: 'runner' }, { viaTaskToken: true })).toEqual({ ...ok, reportedVia: 'task_token' });
    expect(stampEvidence({ ...ok, reportedVia: 'task_token' }, { viaTaskToken: false })).toEqual({ ...ok, reportedVia: 'runner' });
  });

  test('anything that is not an object is no evidence', () => {
    expect(stampEvidence(null, { viaTaskToken: false })).toBeNull();
    expect(stampEvidence([ok], { viaTaskToken: false })).toBeNull();
    expect(stampEvidence('ok', { viaTaskToken: false })).toBeNull();
  });
});

describe('isRunnerReported', () => {
  test('evidence reported on a task token is the agent speaking, not the runner', () => {
    expect(isRunnerReported({ ...ok, reportedVia: 'task_token' })).toBe(false);
    expect(isRunnerReported({ ...ok, reportedVia: 'runner' })).toBe(true);
  });

  test('evidence stored before provenance existed keeps its old meaning', () => {
    expect(isRunnerReported(ok)).toBe(true);
    expect(isRunnerReported(null)).toBe(false);
  });
});

describe('the runner copy wins over an agent copy', () => {
  const runner = { ...ok, reportedVia: 'runner' };
  const agent = { ...ok, outcome: 'failed', exitCode: 1, reportedVia: 'task_token' };

  test('a task-token write never replaces evidence the runner recorded', () => {
    expect(keepStoredEvidence(agent, runner)).toBe(true);
    expect(keepStoredEvidence(runner, agent)).toBe(false);
    expect(keepStoredEvidence(agent, null)).toBe(false);
  });

  test('a completion is decided on the runner copy when the body carries only an agent copy', () => {
    expect(evidenceForCompletion(agent, runner)).toBe(runner);
    expect(evidenceForCompletion(runner, agent)).toBe(runner);
    expect(evidenceForCompletion(null, runner)).toBe(runner);
    expect(evidenceForCompletion(agent, null)).toBe(agent);
  });
});

describe('agentCredential', () => {
  const taskToken = { taskScope: { taskId: 't-1' } };
  test('a task token on a worker a host runner claimed is the agent', () => {
    expect(agentCredential(taskToken, { claimedByCloud: false })).toBe(true);
    expect(agentCredential(taskToken, {})).toBe(true);
  });
  test('on a worker a cloud container claimed, the task token is the runner', () => {
    expect(agentCredential(taskToken, { claimedByCloud: true })).toBe(false);
  });
  test('a runner key is never the agent', () => {
    expect(agentCredential({}, { claimedByCloud: false })).toBe(false);
  });
});
