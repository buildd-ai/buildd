import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockTasksFindFirst = mock(async (): Promise<any> => null);
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: mockTasksFindFirst } } },
}));

import { checkSubjectTask, questionDecisionFields, sensitiveDecisionOptions } from './question-subject';

const SUBJECT = '44444444-4444-4444-8444-444444444444';

describe('checkSubjectTask', () => {
  beforeEach(() => mockTasksFindFirst.mockReset());

  it('absent is fine: the card falls back to the mission', async () => {
    expect(await checkSubjectTask(undefined, { missionId: 'm-1' })).toEqual({ ok: true, subjectTaskId: null });
    expect(await checkSubjectTask('', { missionId: 'm-1' })).toEqual({ ok: true, subjectTaskId: null });
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID without a lookup', async () => {
    const r = await checkSubjectTask('abc', { missionId: 'm-1' });
    expect(r.ok).toBe(false);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('accepts a task in the same mission, refuses one in another', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: SUBJECT, missionId: 'm-1', workspaceId: 'ws-1' });
    expect(await checkSubjectTask(SUBJECT, { missionId: 'm-1', workspaceId: 'ws-1' })).toEqual({ ok: true, subjectTaskId: SUBJECT });
    const other = await checkSubjectTask(SUBJECT, { missionId: 'm-2', workspaceId: 'ws-1' });
    expect(other.ok).toBe(false);
    expect(!other.ok && other.error).toContain('same mission');
  });

  it('without a mission, the workspace is the scope', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: SUBJECT, missionId: null, workspaceId: 'ws-1' });
    expect((await checkSubjectTask(SUBJECT, { workspaceId: 'ws-1' })).ok).toBe(true);
    const r = await checkSubjectTask(SUBJECT, { workspaceId: 'ws-2' });
    expect(!r.ok && r.error).toContain('same workspace');
  });

  it('refuses a task that does not exist', async () => {
    expect((await checkSubjectTask(SUBJECT, { missionId: 'm-1' })).ok).toBe(false);
  });
});

describe('questionDecisionFields', () => {
  it('takes the recommended option as the default when none is given', async () => {
    const r = await questionDecisionFields({ type: 'question', options: ['A', { label: 'B (Recommended)', consequence: 'Ships B.' }] }, { missionId: 'm-1' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.defaultChoice).toBe('B');
    expect(r.options?.[1]).toMatchObject({ label: 'B', recommended: true, effect: 'Ships B' });
  });

  it('keeps an explicit default, and refuses options on a non-question', async () => {
    const r = await questionDecisionFields({ type: 'question', options: ['A', 'B'], defaultChoice: 'A' }, {});
    expect(!('error' in r) && r.defaultChoice).toBe('A');
    expect('error' in (await questionDecisionFields({ type: 'update', options: ['A'] }, {}))).toBe(true);
  });

  it('passes the option-count refusal through', async () => {
    const r = await questionDecisionFields({ type: 'question', options: ['A', 'B', 'C', 'D'] }, {});
    expect('error' in r && r.error).toContain('Cut to two');
  });
});

it('sensitive options keep labels and the recommendation only', () => {
  expect(sensitiveDecisionOptions([{ label: 'A', consequence: 'prose', effect: 'prose', recommended: true }, { label: 'B' }]))
    .toEqual([{ label: 'A', recommended: true }, { label: 'B' }]);
  expect(sensitiveDecisionOptions(null)).toBeNull();
});
