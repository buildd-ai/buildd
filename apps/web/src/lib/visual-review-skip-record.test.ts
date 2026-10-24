import { describe, expect, it } from 'bun:test';
import {
  recordVisualReviewSkip,
  skipSnapshotOf,
  visualReviewSkipCause,
  visualReviewSkipSignature,
  type RecordSkipDeps,
  type RecordSkipInput,
} from './visual-review-skip-record';
import type { MissionVisualReviewState } from './workflow/visual-review-state';

const MISSION = { id: '0b5e1c2a-1111-4111-8111-111111111111', title: 'Mission page polish', workspaceId: '9c8b7a6d-2222-4222-8222-222222222222' };

function state(over: Partial<MissionVisualReviewState> = {}): MissionVisualReviewState {
  return {
    status: 'findings', blocksCompletion: true, blocksMerge: true, pendingVerification: true, staleEvidence: false, passedOnEarlierCommit: false,
    evidenceSha: 'abc1234', nextActor: 'owner', policy: { mode: 'automatic', origin: 'workspace', waiverAllowed: true, locked: false },
    scope: { screens: 4, uiFiles: 2, source: 'diff', workLanded: true }, auditTaskId: 'a1',
    branch: { headSha: 'def5678abcdef', base: 'dev', integrationPr: { number: 12, stage: 'open' }, postMergeRecovery: false },
    ...over,
  };
}

const cell = (route: string, verdict: 'issue' | 'ok', finding: string) => ({
  key: `${route}|mobile|`, route, viewport: 'mobile' as const, variant: null, effectiveVerdict: verdict, standing: verdict === 'issue' ? 'open' : 'fine',
  current: { round: 1, finding, shot: { id: 's1', src: '/api/artifacts/s1/download' } },
}) as any;

function fakeDeps(open: { id: string } | null = null) {
  const calls = { gate: [] as any[], filed: [] as any[], appended: [] as Array<[string, string]> };
  const deps: RecordSkipDeps = {
    recordGateEvent: async (e) => { calls.gate.push(e); },
    findOpenBug: async () => open,
    appendToBug: async (id, text) => { calls.appended.push([id, text]); },
    fileBug: async (row) => { calls.filed.push(row); return { id: 'bug-1' }; },
  };
  return { deps, calls };
}

const snapshot = skipSnapshotOf(state(), { cells: [cell('/app/missions/:id', 'issue', 'Header overlaps the rail at 390px'), cell('/app/tasks', 'ok', '')] });
const input = (over: Partial<RecordSkipInput> = {}): RecordSkipInput => ({
  mission: MISSION, skipReason: 'wrong_or_stuck', note: null, actorLabel: 'Maya', callerOrigin: 'dashboard', snapshot, ...over,
});

describe('the cause a wrong-or-stuck Skip is filed under', () => {
  it('reads the review the person was looking at', () => {
    expect(visualReviewSkipCause(state({ status: 'blocked', blocked: { cause: 'app_boot_failed', causeOwner: 'unknown', autoRetriesLeft: 0 } }))).toBe('app_boot_failed');
    expect(visualReviewSkipCause(state({ status: 'blocked', blocked: { cause: 'capture_auth', causeOwner: 'workspace', autoRetriesLeft: 0 } }))).toBe('capture_setup');
    expect(visualReviewSkipCause(state({ status: 'queued', waitingOn: { taskId: 't', title: null } }))).toBe('waiting_on_failed_work');
    expect(visualReviewSkipCause(state({ recapture: { next: 'decide', screens: ['/a · phone'], routes: ['/a'] } }))).toBe('fix_not_rechecked');
    expect(visualReviewSkipCause(state())).toBe('findings_wrong');
    expect(visualReviewSkipCause(state({ status: 'needed', scheduleBlock: { cause: 'rereview_cap', reason: '5 review rounds have run' } }))).toBe('audit_not_filed');
    expect(visualReviewSkipCause(state({ status: 'queued' }))).toBe('never_started');
    expect(visualReviewSkipCause(state({ status: 'queued', holdReason: 'no browser runner' }))).toBe('audit_held');
    expect(visualReviewSkipCause(state({ status: 'needed', nextActor: 'owner' }))).toBe('awaiting_approval');
    expect(visualReviewSkipCause(state({ status: 'needed', nextActor: 'system', staleEvidence: true }))).toBe('new_commit_unaudited');
    expect(visualReviewSkipCause(state({ status: 'running' }))).toBe('still_running');
    expect(visualReviewSkipCause(null)).toBe('unknown');
  });

  it('carries the commit and the open findings with their screenshots', () => {
    expect(snapshot).toMatchObject({ commit: 'def5678abcdef', cause: 'findings_wrong', openFindings: 1 });
    expect(snapshot.findings).toEqual([{ route: '/app/missions/:id', viewport: 'mobile', state: null, finding: 'Header overlaps the rail at 390px', screenshot: '/api/artifacts/s1/download' }]);
  });
});

// Spec 072de598 r15 AC-26 / I-19.
describe('recordVisualReviewSkip', () => {
  it('wrong or stuck files exactly one visual-review bug with the mission, commit, findings and screenshots', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordVisualReviewSkip(input({ note: 'The header is fine on a real phone' }), deps, new Date('2026-10-23T10:00:00Z'));
    expect(out.bug).toEqual({ taskId: 'bug-1', outcome: 'created' });
    expect(calls.filed).toHaveLength(1);
    const bug = calls.filed[0];
    expect(bug.signature).toBe(visualReviewSkipSignature('findings_wrong'));
    expect(bug.title).toBe('[friction] visual review wrong or stuck: the findings were wrong');
    expect(bug.description).toContain('Mission: "Mission page polish" (0b5e1c2a');
    expect(bug.description).toContain('Commit: def5678abcde');
    expect(bug.description).toContain('Header overlaps the rail at 390px');
    expect(bug.description).toContain('/api/artifacts/s1/download');
    expect(bug.description).toContain('Their note: The header is fine on a real phone');
    expect(bug.workspaceId).toBe(MISSION.workspaceId);
  });

  it('a cause already tracked gets the occurrence added to its open bug, not a new one', async () => {
    const { deps, calls } = fakeDeps({ id: 'bug-open' });
    const out = await recordVisualReviewSkip(input(), deps);
    expect(out.bug).toEqual({ taskId: 'bug-open', outcome: 'appended' });
    expect(calls.filed).toHaveLength(0);
    expect(calls.appended).toHaveLength(1);
    expect(calls.appended[0][1]).toContain('Skipped again as wrong or stuck');
    expect(calls.appended[0][1]).toContain('Mission page polish');
  });

  it('ship it anyway files nothing, and is still recorded with the findings it accepted', async () => {
    const { deps, calls } = fakeDeps();
    const out = await recordVisualReviewSkip(input({ skipReason: 'ship_anyway' }), deps);
    expect(out.bug).toBeNull();
    expect(calls.filed).toHaveLength(0);
    expect(calls.appended).toHaveLength(0);
    expect(calls.gate).toHaveLength(1);
    expect(calls.gate[0].detail).toMatchObject({ skipReason: 'ship_anyway', openFindings: 1 });
  });

  it('every Skip lands in the gate ledger with its reason button, person, mission, commit and open findings', async () => {
    const { deps, calls } = fakeDeps();
    await recordVisualReviewSkip(input(), deps);
    expect(calls.gate[0]).toMatchObject({
      gate: 'visual_review_skip', outcome: 'bypassed', missionId: MISSION.id, workspaceId: MISSION.workspaceId, taskId: 'bug-1',
      detail: { skipReason: 'wrong_or_stuck', label: 'The review is wrong or stuck', actor: 'Maya', commit: 'def5678abcdef', cause: 'findings_wrong', openFindings: 1, bugTaskId: 'bug-1' },
    });
  });

  it('a bug that cannot be filed still leaves the Skip on record', async () => {
    const { deps, calls } = fakeDeps();
    deps.fileBug = async () => { throw new Error('db down'); };
    const orig = console.error;
    console.error = () => {};
    try {
      const out = await recordVisualReviewSkip(input(), deps);
      expect(out.bug).toBeNull();
    } finally { console.error = orig; }
    expect(calls.gate).toHaveLength(1);
  });
});
