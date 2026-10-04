/**
 * The shared fix-status label (visual-fix-label.ts): every surface — the UI's
 * `FixStatus` and the chat/MCP text line — derives its copy from this, never
 * from `fix.status` alone. Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import type { VisualReviewFixTask } from '@buildd/shared';
import { findingIsStillThere, fixStatusLabel } from '../visual-fix-label';

const fix = (over: Partial<VisualReviewFixTask> = {}): VisualReviewFixTask => ({
  id: 'fx1',
  title: '[surface fix] /a: x',
  status: 'completed',
  prUrl: null,
  prNumber: null,
  mergedAt: null,
  mergedInto: null,
  origin: 'auditor',
  ...over,
});

describe('fixStatusLabel', () => {
  it('a completed task with no PR never reads as shipped', () => {
    expect(fixStatusLabel(fix({ status: 'completed' }))).toEqual({ text: 'Task finished, no PR merged', tone: 'warning' });
  });

  it('an open PR, not yet merged, says so while the task is still running', () => {
    expect(fixStatusLabel(fix({ status: 'in_progress', prUrl: 'https://example.test/pr/1', prNumber: 1 })))
      .toEqual({ text: 'PR open, not merged', tone: 'warning' });
  });

  it('a failed task outranks a PR left open from before it failed', () => {
    expect(fixStatusLabel(fix({ status: 'failed', prUrl: 'https://example.test/pr/1', prNumber: 1 })))
      .toEqual({ text: 'Task failed, no PR merged', tone: 'warning' });
  });

  it('a cancelled task outranks a PR left open from before it was cancelled', () => {
    expect(fixStatusLabel(fix({ status: 'cancelled', prUrl: 'https://example.test/pr/1', prNumber: 1 })))
      .toEqual({ text: 'Fix cancelled', tone: 'muted' });
  });

  it('a PR merged to trunk reads green', () => {
    expect(fixStatusLabel(fix({ prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'trunk' })))
      .toEqual({ text: 'PR merged', tone: 'success' });
  });

  it('a PR merged only to the mission\'s own branch never reads the same as trunk', () => {
    expect(fixStatusLabel(fix({ prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'mission_branch' })))
      .toEqual({ text: 'PR merged to mission branch only', tone: 'warning' });
  });

  it('a failed task with no PR says so', () => {
    expect(fixStatusLabel(fix({ status: 'failed' }))).toEqual({ text: 'Task failed, no PR merged', tone: 'warning' });
  });

  it('a cancelled fix is muted, not warning', () => {
    expect(fixStatusLabel(fix({ status: 'cancelled' }))).toEqual({ text: 'Fix cancelled', tone: 'muted' });
  });

  it('a running fix falls back to its own status word', () => {
    expect(fixStatusLabel(fix({ status: 'in_progress' }))).toEqual({ text: 'in progress', tone: 'warning' });
  });

  it('stillPresent overrides even a merged, otherwise-green fix', () => {
    expect(fixStatusLabel(
      fix({ status: 'completed', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-03-10T10:00:00.000Z', mergedInto: 'trunk' }),
      { stillPresent: true },
    )).toEqual({ text: 'Fix finished, problem still present', tone: 'warning' });
  });

  it('stillPresent is a no-op on a fix that has not finished yet', () => {
    expect(fixStatusLabel(fix({ status: 'in_progress' }), { stillPresent: true })).toEqual({ text: 'in progress', tone: 'warning' });
  });
});

describe('findingIsStillThere', () => {
  it('matches the auditor\'s own round-2+ convention, case-insensitively', () => {
    expect(findingIsStillThere('Still there: the overflow persists.')).toBe(true);
    expect(findingIsStillThere('still there, unchanged.')).toBe(true);
    expect(findingIsStillThere('STILL THERE')).toBe(true);
  });

  it('does not match a resolved finding or unrelated prose', () => {
    expect(findingIsStillThere('Resolved: the title now truncates.')).toBe(false);
    expect(findingIsStillThere('The header still looks fine.')).toBe(false);
    expect(findingIsStillThere(null)).toBe(false);
    expect(findingIsStillThere(undefined)).toBe(false);
  });
});
