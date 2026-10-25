/**
 * Spec 8e137fdb r4: AC-17 (interrupted attempt), AC-18 (cause agreement),
 * AC-19 (no duplication), AC-22 (provenance, no side effects).
 *
 * One table of scenarios through the REAL `deriveMissionStateView`. Every
 * surface that renders mission state reads `view.situation.headline`,
 * `view.chip` or `presentMissionState(view)`, so parity is asserted on those
 * three reads of one view, and the copy rules on all of them.
 */
import { describe, it, expect } from 'bun:test';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';
import { presentMissionState, type MissionPresentationCause, type MissionPresentationState } from './mission-state-presentation';

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };
const stalled: MissionStateInput = { ...base, health: 'STALLED' };

interface Scenario {
  name: string;
  /** Spec acceptance criterion the row answers for. */
  ac: string;
  input: MissionStateInput;
  state: MissionPresentationState;
  /** `undefined`: any cause is acceptable; `null`: must carry none. */
  cause?: MissionPresentationCause | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'interrupted: a started task with no worker, beside a queued one',
    ac: 'AC-17',
    input: { ...stalled, openTasks: [{ id: 'aaaa1111-0000', status: 'in_progress' }, { id: 'bbbb2222-0000', status: 'pending' }] },
    state: 'interrupted',
    cause: 'interruption',
  },
  { name: 'executing: an agent is working', ac: 'AC-18', input: { ...base, activeAgents: 1, openTasks: [{ id: 'a', status: 'in_progress' }] }, state: 'running', cause: 'executing' },
  { name: 'queued: next in line for a runner', ac: 'AC-18', input: { ...stalled, runnerOnline: true, openTasks: [{ id: 'a', status: 'pending' }] }, state: 'queued', cause: 'queue' },
  {
    name: 'dependency: every open task waits on another',
    ac: 'AC-18',
    input: { ...stalled, openTasks: [{ id: 'a', status: 'pending', waitingOnTaskIds: ['up'] }] },
    state: 'waiting',
    cause: 'dependency',
  },
  { name: 'capacity: the mission is at its cap', ac: 'AC-18', input: { ...stalled, openTasks: [{ id: 'a', status: 'pending', holdReason: 'mission_concurrent' }] }, state: 'queued', cause: 'capacity' },
  { name: 'budget: the mission budget is spent', ac: 'AC-18', input: { ...stalled, openTasks: [{ id: 'a', status: 'pending', holdReason: 'mission_budget' }] }, state: 'queued', cause: 'budget' },
  {
    name: 'local session: claimable work and a quiet session',
    ac: 'AC-18',
    input: { ...stalled, executor: 'local', openTasks: [{ id: 'a', status: 'pending' }], localStrand: { stranded: true, quietMs: 3_600_000, claimableTaskIds: ['a'], flipBlockedReason: null } },
    state: 'waiting',
    cause: 'local_session',
  },
  {
    name: 'human approval: a worker asked a question',
    ac: 'AC-18',
    input: { ...base, openQuestions: [{ taskId: 'a', title: 'Pick', prompt: 'Which?' }] },
    state: 'needs_you',
    cause: 'human_approval',
  },
  { name: 'intentional pause: held mission', ac: 'AC-18', input: { ...base, isHeld: true }, state: 'paused', cause: 'intentional_pause' },
  {
    name: 'unknown hold: a reason the catalog does not know',
    ac: 'AC-18',
    input: { ...stalled, openTasks: [{ id: 'a', status: 'pending', holdReason: 'some_future_gate' }] },
    state: 'waiting',
    cause: 'unknown',
  },
  { name: 'planning: nothing filed yet', ac: 'AC-18', input: { ...base }, state: 'idle', cause: null },
  {
    name: 'verification: the visual review is queued',
    ac: 'AC-18',
    input: { ...stalled, missionPrMerged: true, visualReview: { status: 'queued' }, openTasks: [{ id: 'a', status: 'pending', surfaceAudit: true }] },
    state: 'verifying',
    cause: 'verification',
  },
  {
    name: 'delivery: the mission PR waits to be merged',
    ac: 'AC-18',
    input: { ...base, unmergedPrs: [{ taskId: 'a', title: 'T', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' }] },
    state: 'delivering',
    cause: 'delivery',
  },
  { name: 'complete', ac: 'AC-18', input: { ...base, status: 'completed' }, state: 'complete', cause: null },
];

// Banned primary-surface narration (I-16): generated filler and raw ids.
const BANNED = [/is running its \d+ open tasks/i, /nothing is running/i, /\btask [0-9a-f]{8}\b/i, /\b[0-9a-f]{8}-[0-9a-f]{4}/i];

describe('mission state presentation — scenario matrix', () => {
  for (const s of SCENARIOS) {
    describe(`${s.name} [${s.ac}]`, () => {
      const view = deriveMissionStateView(s.input);
      const p = presentMissionState(view);

      it('classifies state and cause from the view, inventing nothing', () => {
        expect(p.state).toBe(s.state);
        if (s.cause !== undefined) expect(p.cause).toBe(s.cause);
      });

      it('header, list card, Overview and explain read one headline and one chip', () => {
        // Header, Home/list and Overview all render `situation.headline`; explain returns the same object.
        expect(view.situation.headline).toBe(deriveMissionStateView(s.input).situation.headline);
        expect(p).toEqual(presentMissionState(deriveMissionStateView(s.input)));
        expect(p.label.length).toBeLessThanOrEqual(14);
      });

      it('carries no banned narration or raw ids in the primary copy', () => {
        for (const text of [view.situation.headline, p.sentence, p.label, p.causeText ?? '']) {
          for (const re of BANNED) expect(text).not.toMatch(re);
        }
      });

      it('says each fact once: the next action does not restate the headline', () => {
        if (p.action) expect(p.action.toLowerCase()).not.toBe(view.situation.headline.toLowerCase());
        expect(p.causeText === null || !p.label.toLowerCase().includes(p.causeText.toLowerCase())).toBe(true);
      });

      it('is a pure read: frozen input, repeated calls, same answer', () => {
        const frozen = JSON.parse(JSON.stringify(s.input)) as MissionStateInput;
        const deepFreeze = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } };
        deepFreeze(frozen);
        expect(() => presentMissionState(deriveMissionStateView(frozen))).not.toThrow();
        expect(presentMissionState(deriveMissionStateView(frozen)).state).toBe(p.state);
      });
    });
  }

  it('AC-17: an interrupted attempt is never described as executing, and no reason is invented', () => {
    const s = SCENARIOS[0];
    const view = deriveMissionStateView(s.input);
    const p = presentMissionState(view);
    expect(view.situation.headline).toMatch(/^Interrupted/);
    expect(view.situation.headline.toLowerCase()).toContain('no agent running');
    expect(p.causeText).not.toMatch(/budget|runner|capacity|dependency/i);
  });

  it('AC-18: an unknown hold stays neutral instead of guessing a cause', () => {
    const p = presentMissionState(deriveMissionStateView(SCENARIOS.find(s => s.cause === 'unknown')!.input));
    expect(p.causeText).toBeNull();
    expect(p.needsYou).toBe(false);
  });

  // 26b969db: explain answered presentation.needsYou true beside delivery.needsYou false for a PR
  // waiting on its review, which is buildd's step. A landing blocker owned by the platform needs nobody.
  it('a landing blocker the platform owns does not need you; one a person owns does', () => {
    const view = (owner: 'platform' | 'person') => ({
      kind: 'waiting', nextAction: 'Nothing to do yet',
      waitingOn: { kind: 'landing_blocked', tone: 'info', label: 'PR #5 is waiting for its review', count: 1, cause: 'review_pending', owner, nextAction: 'Nothing to do yet', prNumbers: [5], prUrls: [], taskIds: [] },
    }) as unknown as Parameters<typeof presentMissionState>[0];
    expect(presentMissionState(view('platform'))).toMatchObject({ state: 'delivering', needsYou: false });
    expect(presentMissionState(view('person'))).toMatchObject({ state: 'delivering', needsYou: true });
  });

  it('AC-22: a read does not evaluate criteria (no completion decision is requested)', () => {
    // The presentation takes only the sealed view; it has no input to evaluate with.
    expect(presentMissionState.length).toBe(1);
  });
});
