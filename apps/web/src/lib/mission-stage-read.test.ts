import { beforeEach, describe, expect, it, mock } from 'bun:test';

let stored = new Map<string, any>();
let storedFails = false;
const mockRead = mock(async (_ids: readonly string[], _ws: readonly string[]) => {
  if (storedFails) throw new Error('relation "mission_summaries" does not exist');
  return stored;
});
const mockRefresh = mock((..._ids: Array<string | null | undefined>) => {});
let live = new Map<string, any>();
const mockLive = mock(async (_ids: string[], _ws: string[]) => live);

mock.module('./mission-summary-store', () => ({ readMissionSummaries: mockRead, refreshMissionSummary: mockRefresh }));
mock.module('./mission-stage-load', () => ({ loadMissionStages: mockLive }));

const { loadMissionStagesFromSummaries } = await import('./mission-stage-read');

const stage = (step: string) => ({ step, waitingOn: null, progress: [] });

beforeEach(() => {
  stored = new Map();
  storedFails = false;
  live = new Map();
  mockRead.mockClear();
  mockRefresh.mockClear();
  mockLive.mockClear();
});

describe('loadMissionStagesFromSummaries (spec 3ef37387 R-13)', () => {
  it('reads the stored stage, scoped to the caller, and derives nothing when every mission has one', async () => {
    stored = new Map([['m1', { summary: { stage: stage('building') } }], ['m2', { summary: { stage: stage('delivered') } }]]);
    const out = await loadMissionStagesFromSummaries(['m1', 'm2'], ['ws-1']);
    expect(mockRead).toHaveBeenCalledWith(['m1', 'm2'], ['ws-1']);
    expect(Object.fromEntries(out)).toEqual({ m1: stage('building'), m2: stage('delivered') });
    expect(mockLive).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('a mission not yet summarised is derived live, and its summary is queued', async () => {
    stored = new Map([['m1', { summary: { stage: stage('building') } }]]);
    live = new Map([['m2', stage('planning')]]);
    const out = await loadMissionStagesFromSummaries(['m1', 'm2', 'm-other-team'], ['ws-1']);
    expect(mockLive).toHaveBeenCalledWith(['m2', 'm-other-team'], ['ws-1']);
    expect(Object.fromEntries(out)).toEqual({ m1: stage('building'), m2: stage('planning') });
    // Only what the live loader found (in the caller's workspaces) is queued.
    expect(mockRefresh).toHaveBeenCalledWith('m2');
  });

  it('an unreadable summary table falls back to the live derivation for every mission', async () => {
    storedFails = true;
    live = new Map([['m1', stage('building')]]);
    const out = await loadMissionStagesFromSummaries(['m1'], ['ws-1']);
    expect(Object.fromEntries(out)).toEqual({ m1: stage('building') });
  });

  it('reads nothing with no missions or no workspaces', async () => {
    expect((await loadMissionStagesFromSummaries([], ['ws-1'])).size).toBe(0);
    expect((await loadMissionStagesFromSummaries(['m1'], [])).size).toBe(0);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockLive).not.toHaveBeenCalled();
  });
});
