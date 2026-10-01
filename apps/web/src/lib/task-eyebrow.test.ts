import { describe, expect, it } from 'bun:test';
import { deriveTaskEyebrow, roleDisplayName, taskEyebrowText } from './task-eyebrow';

const builder = { slug: 'builder', name: 'Builder', color: '#C47A3A' };

describe('roleDisplayName', () => {
  it('prefers the role name, falls back to the slug', () => {
    expect(roleDisplayName('builder', 'Builder')).toBe('Builder');
    expect(roleDisplayName('builder', null)).toBe('builder');
  });

  it('returns null for a task with no role — never a placeholder word', () => {
    expect(roleDisplayName(null)).toBeNull();
    expect(roleDisplayName('', '')).toBeNull();
    expect(roleDisplayName(undefined, undefined)).toBeNull();
  });
});

describe('deriveTaskEyebrow — pending', () => {
  it('shows the stated role', () => {
    expect(deriveTaskEyebrow({ status: 'pending', role: builder })).toEqual({
      kind: 'role', label: 'Builder', color: '#C47A3A', inferred: false, runner: null,
    });
  });

  it('hides the eyebrow when the task has no role', () => {
    expect(deriveTaskEyebrow({ status: 'pending', role: null })).toBeNull();
  });

  it('marks an inferred role as auto', () => {
    const e = deriveTaskEyebrow({ status: 'pending', role: builder, roleInferred: true });
    expect(e).toMatchObject({ kind: 'role', label: 'Builder', inferred: true });
    expect(taskEyebrowText(e)).toBe('Builder · auto');
  });
});

describe('deriveTaskEyebrow — running', () => {
  it('shows the role only when one runner is online', () => {
    const e = deriveTaskEyebrow({ status: 'assigned', workerStatus: 'running', role: builder, runner: 'coder-a', onlineRunners: 1 });
    expect(e).toMatchObject({ kind: 'role', label: 'Builder', runner: null });
  });

  it('adds the runner when the team has more than one runner online', () => {
    const e = deriveTaskEyebrow({ status: 'assigned', workerStatus: 'running', role: builder, runner: 'coder-a', onlineRunners: 2 });
    expect(e).toMatchObject({ kind: 'role', label: 'Builder', runner: 'coder-a' });
    expect(taskEyebrowText(e)).toBe('Builder · coder-a');
  });

  it('shows just the runner for a roleless task on a multi-runner team', () => {
    const e = deriveTaskEyebrow({ status: 'in_progress', workerStatus: 'running', role: null, runner: 'coder-a', onlineRunners: 3 });
    expect(e).toEqual({ kind: 'runner', label: 'coder-a' });
  });

  it('hides the eyebrow for a roleless task on a single-runner team', () => {
    expect(deriveTaskEyebrow({ status: 'in_progress', workerStatus: 'running', role: null, runner: 'coder-a', onlineRunners: 1 })).toBeNull();
  });

  it('treats a live worker as running even while the task row still reads pending', () => {
    const e = deriveTaskEyebrow({ status: 'pending', workerStatus: 'waiting_input', role: null, runner: 'coder-b', onlineRunners: 2 });
    expect(e).toEqual({ kind: 'runner', label: 'coder-b' });
  });
});

describe('deriveTaskEyebrow — terminal', () => {
  it('drops the role and says the PR merged', () => {
    const e = deriveTaskEyebrow({ status: 'completed', role: builder, pr: { number: 3221, mergedAt: new Date() } });
    expect(e).toEqual({ kind: 'outcome', label: 'merged #3221', tone: 'success' });
  });

  it('reads merged from the PR lifecycle when mergedAt is not loaded', () => {
    const e = deriveTaskEyebrow({ status: 'completed', role: null, pr: { number: 7, lifecycle: 'merged' } });
    expect(e).toMatchObject({ label: 'merged #7', tone: 'success' });
  });

  it('says the PR is still open — completed is not landed', () => {
    const e = deriveTaskEyebrow({ status: 'completed', role: null, pr: { number: 3221, lifecycle: 'ci_green' } });
    expect(e).toEqual({ kind: 'outcome', label: 'PR open #3221', tone: 'warning' });
  });

  it('says the PR closed unmerged', () => {
    const e = deriveTaskEyebrow({ status: 'failed', role: builder, pr: { number: 9, lifecycle: 'closed' } });
    expect(e).toEqual({ kind: 'outcome', label: 'PR closed #9', tone: 'muted' });
  });

  it('names artifacts when the task shipped no PR', () => {
    expect(deriveTaskEyebrow({ status: 'completed', role: builder, artifactCount: 2 }))
      .toEqual({ kind: 'outcome', label: '2 artifacts', tone: 'muted' });
    expect(deriveTaskEyebrow({ status: 'completed', role: builder, artifactCount: 1 }))
      .toMatchObject({ label: '1 artifact' });
  });

  it('hides the eyebrow when nothing shipped — never "unassigned" next to completed', () => {
    expect(deriveTaskEyebrow({ status: 'completed', role: null })).toBeNull();
    expect(deriveTaskEyebrow({ status: 'completed', role: builder })).toBeNull();
    expect(deriveTaskEyebrow({ status: 'cancelled', role: builder, pr: { number: 4 } })).toBeNull();
  });
});

describe('deriveTaskEyebrow — bookkeeping', () => {
  it('never renders an eyebrow for a bookkeeping row', () => {
    expect(deriveTaskEyebrow({ status: 'pending', role: builder, taskClass: 'bookkeeping' })).toBeNull();
    expect(deriveTaskEyebrow({ status: 'completed', role: null, taskClass: 'bookkeeping', pr: { number: 1, mergedAt: new Date() } })).toBeNull();
  });
});

describe('taskEyebrowText', () => {
  it('is empty for no eyebrow', () => {
    expect(taskEyebrowText(null)).toBe('');
  });
});
