import { describe, it, expect } from 'bun:test';
import { buildWorkflowRunOutcome, type WorkflowRunPayload } from './workflow-run';
import type { ReleaseResult } from '@buildd/core/db/schema';

const baseRun = (over: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => ({
  id: 12345,
  name: 'Release Handoff',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/buildd-ai/buildd/actions/runs/12345',
  head_branch: 'dev',
  ...over,
});

const pendingResult: ReleaseResult = {
  status: 'pending_ci',
  message: 'Release: dispatched release-handoff.yml@dev — awaiting workflow completion',
  runId: 12345,
  runUrl: 'https://github.com/buildd-ai/buildd/actions/runs/12345',
  runStatus: 'in_progress',
  runConclusion: null,
};

describe('buildWorkflowRunOutcome', () => {
  it('maps a successful run to completed status', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun());
    expect(result.status).toBe('completed');
    expect(result.runStatus).toBe('completed');
    expect(result.runConclusion).toBe('success');
    expect(result.runUrl).toBe('https://github.com/buildd-ai/buildd/actions/runs/12345');
    expect(result.message).toContain('completed');
    expect(result.message).toContain('Release Handoff');
    expect(result.error).toBeUndefined();
  });

  it('maps a failed run to failed status with error', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ conclusion: 'failure' }));
    expect(result.status).toBe('failed');
    expect(result.runConclusion).toBe('failure');
    expect(result.message).toContain('FAILED');
    expect(result.message).toContain('failure');
    expect(result.error).toContain('failure');
  });

  it('maps a timed_out conclusion to failed', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ conclusion: 'timed_out' }));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('timed_out');
  });

  it('maps a cancelled conclusion to failed', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ conclusion: 'cancelled' }));
    expect(result.status).toBe('failed');
  });

  it('preserves existing runId from previous result', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun());
    expect(result.runId).toBe(12345);
  });

  it('preserves a previously-set mergedAt on success', () => {
    const withMerge: ReleaseResult = { ...pendingResult, mergedAt: '2026-07-01T00:00:00.000Z' };
    const result = buildWorkflowRunOutcome(withMerge, baseRun());
    expect(result.mergedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('sets mergedAt to now when not previously set (success path)', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun());
    expect(result.mergedAt).toBeTruthy();
    expect(typeof result.mergedAt).toBe('string');
  });

  it('does not set mergedAt on failure', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ conclusion: 'failure' }));
    expect(result.mergedAt).toBeUndefined();
  });

  it('includes branch name in success message when available', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ head_branch: 'dev' }));
    expect(result.message).toContain('dev');
  });

  it('handles null head_branch gracefully', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ head_branch: null }));
    expect(result.message).toContain('unknown');
  });

  it('handles null conclusion gracefully on failure path', () => {
    const result = buildWorkflowRunOutcome(pendingResult, baseRun({ conclusion: null }));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('unknown');
    expect(result.error).toContain('unknown');
  });

  it('carries through unrelated previous fields', () => {
    const withHooks: ReleaseResult = {
      ...pendingResult,
      hooksRan: [{ description: 'notify', success: true }],
    };
    const result = buildWorkflowRunOutcome(withHooks, baseRun());
    expect(result.hooksRan).toEqual([{ description: 'notify', success: true }]);
  });
});
