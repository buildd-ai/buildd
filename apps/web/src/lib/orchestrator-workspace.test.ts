import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockFindFirst = mock(() => null as any);
const mockInsertReturning = mock(() => [{ id: 'new-ws-id' }] as any);
const mockInsertValues = mock(() => ({ returning: mockInsertReturning }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockFindFirst },
    },
    insert: mockInsert,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', name: 'name', teamId: 'teamId' },
}));

import { getOrCreateCoordinationWorkspace } from './orchestrator-workspace';

describe('getOrCreateCoordinationWorkspace', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();

    // Restore mock chain
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
  });

  it('returns existing orchestrator workspace if found', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-ws-id' });

    const result = await getOrCreateCoordinationWorkspace('team-1');
    expect(result).toEqual({ id: 'existing-ws-id' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('creates a new orchestrator workspace when none exists', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{ id: 'new-ws-id' }]);

    const result = await getOrCreateCoordinationWorkspace('team-1');
    expect(result).toEqual({ id: 'new-ws-id' });
    expect(mockInsert).toHaveBeenCalled();

    // Verify insert values
    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.name).toBe('__coordination');
    expect(insertCall.teamId).toBe('team-1');
    expect(insertCall.accessMode).toBe('open');
  });

  it('passes correct team ID for different teams', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{ id: 'ws-for-team-2' }]);

    const result = await getOrCreateCoordinationWorkspace('team-2');
    expect(result).toEqual({ id: 'ws-for-team-2' });

    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.teamId).toBe('team-2');
  });
});
