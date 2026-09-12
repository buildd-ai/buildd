import { describe, it, expect } from 'bun:test';
import { isSchemaDriftFailure, buildDriftDiagnoseTask, SCHEMA_DRIFT_JOB_NAME } from './ci-drift-diagnose';

describe('isSchemaDriftFailure', () => {
  it('is true when the schema-drift job is among the failed jobs', () => {
    expect(isSchemaDriftFailure(['build', SCHEMA_DRIFT_JOB_NAME])).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isSchemaDriftFailure([`  ${SCHEMA_DRIFT_JOB_NAME.toUpperCase()}  `])).toBe(true);
  });

  it('is false for ordinary CI failures', () => {
    expect(isSchemaDriftFailure(['build', 'Sandbox isolation probe (bwrap)'])).toBe(false);
  });

  it('is false for empty/missing job lists', () => {
    expect(isSchemaDriftFailure([])).toBe(false);
    expect(isSchemaDriftFailure(null)).toBe(false);
    expect(isSchemaDriftFailure(undefined)).toBe(false);
  });
});

describe('buildDriftDiagnoseTask', () => {
  const params = {
    originalTask: { id: 't1', title: 'Release v1.2.3', workspaceId: 'ws1', missionId: 'm1' },
    repoFullName: 'buildd-ai/buildd',
    prNumber: 42,
    headSha: 'abc123',
    failureContext: 'Job "Schema Drift / check-prod" failed',
    ciRunUrl: 'https://github.com/buildd-ai/buildd/actions/runs/999',
  };

  it('is never a fix task — no PR requirement, diagnose-only framing', () => {
    const task = buildDriftDiagnoseTask(params);
    expect(task.outputRequirement).toBe('artifact_required');
    expect(task.title).toContain('[CI Diagnose]');
    expect(task.description.toLowerCase()).toContain('do not');
    expect(task.description).toContain('Do **not** open a PR');
    expect(task.description).toContain('Do **not** generate or apply a migration');
    expect(task.description).toContain('Do **not** touch the production database');
  });

  it('names the classification signal (check name) in the description', () => {
    const task = buildDriftDiagnoseTask(params);
    expect(task.description).toContain(SCHEMA_DRIFT_JOB_NAME);
    expect(task.description.toLowerCase()).toContain('check name only');
  });

  it('inherits workspace/mission and links back to the original task', () => {
    const task = buildDriftDiagnoseTask(params);
    expect(task.workspaceId).toBe('ws1');
    expect(task.missionId).toBe('m1');
    expect(task.parentTaskId).toBe('t1');
    expect(task.taskClass).toBe('attempt');
    expect(task.creationSource).toBe('webhook');
  });

  it('defaults missionId to null when the original task has none', () => {
    const task = buildDriftDiagnoseTask({ ...params, originalTask: { ...params.originalTask, missionId: null } });
    expect(task.missionId).toBeNull();
  });
});
