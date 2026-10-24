import { describe, it, expect } from 'bun:test';
import { renderStartAnyway } from '../../src/prompt-builder';
import { buildAssessmentBrief } from '@buildd/core/start-anyway';

// Start anyway (spec 36df686b R-4, R-8, R-10): the claim stores the assessment
// text with the prerequisites' live state; the attempt's prompt carries it, and
// after a park the resume section carries the saved assessment instead.
const assessment = (at: string) => ({
  at,
  text: buildAssessmentBrief({
    task: { id: 't1', title: 'Dependent' },
    prerequisites: [{ id: 'up-1', title: 'Upstream task', status: 'in_progress', worker: { id: 'w', status: 'running' } }],
    recoveryOutcomes: [],
  }).text,
});

describe('renderStartAnyway', () => {
  it('renders nothing for a task nobody started anyway', () => {
    expect(renderStartAnyway(undefined)).toBeNull();
    expect(renderStartAnyway({})).toBeNull();
  });

  it('carries the assessment with the live prerequisite state and the park operation', () => {
    const out = renderStartAnyway({ startAnywayAssessment: assessment('2026-10-24T10:00:00Z') })!;
    expect(out).toContain('Upstream task');
    expect(out).toContain('in_progress');
    expect(out).toContain('blockedOnTaskId');
    expect(out).toContain('send_worker_message');
  });

  it('after a park it resumes with the saved assessment, not a second assessment', () => {
    const out = renderStartAnyway({
      startAnywayAssessment: assessment('2026-10-24T10:00:00Z'),
      waitExit: { blockerTaskId: 'up-1', reason: 'Needs the new API; nothing else to do yet', at: '2026-10-24T11:00:00Z' },
    })!;
    expect(out).toContain('resuming');
    expect(out).toContain('Needs the new API');
    expect(out).not.toContain('assess before you build');
  });

  it('a new Start anyway after the park assesses again', () => {
    const out = renderStartAnyway({
      startAnywayAssessment: assessment('2026-10-24T12:00:00Z'),
      waitExit: { blockerTaskId: 'up-1', reason: 'old', at: '2026-10-24T11:00:00Z' },
    })!;
    expect(out).toContain('assess before you build');
  });
});
