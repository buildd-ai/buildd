import { describe, expect, test } from 'bun:test';
import {
  ATTEMPT_FLIP,
  ATTEMPT_TIE_AT,
  LEGACY_LATEST_HEADLINE,
  LEGACY_PERCENT_STREAM,
  RUN_ACTIVITY_FIXTURE_STATE,
  RUN_ACTIVITY_SCENARIOS,
  STEERING_MESSAGES,
  attemptTie,
  legacyStreamWorker,
  parseRunActivityScenario,
  researchWorker,
  steeringEndedWorker,
  steeringLiveWorker,
  withFlippedStatus,
} from './run-activity-fixtures';
import { FIXTURE_VIEWS, isFixtureView } from './visual-review-fixtures';
import { deriveNow } from '../../(protected)/tasks/[id]/task-activity';

describe('run-activity fixture scenarios', () => {
  test('the page understands ?state=run-activity', () => {
    expect(FIXTURE_VIEWS).toContain(RUN_ACTIVITY_FIXTURE_STATE);
    expect(isFixtureView(RUN_ACTIVITY_FIXTURE_STATE)).toBe(true);
  });

  test('&scenario= picks one scenario; absent or unknown renders all', () => {
    expect(parseRunActivityScenario(new URLSearchParams('scenario=error'))).toEqual(['error']);
    expect(parseRunActivityScenario(new URLSearchParams('scenario=nope'))).toEqual([...RUN_ACTIVITY_SCENARIOS]);
    expect(parseRunActivityScenario(new URLSearchParams(''))).toEqual([...RUN_ACTIVITY_SCENARIOS]);
  });

  test('the legacy stream is non-monotonic, in milestone order', () => {
    const reported = legacyStreamWorker.milestones
      .filter((m): m is Extract<typeof m, { type: 'status' }> => m.type === 'status' && typeof m.progress === 'number')
      .sort((a, b) => a.ts - b.ts)
      .map(m => m.progress);
    expect(reported).toEqual([...LEGACY_PERCENT_STREAM]);
    expect(reported.some((p, i) => i > 0 && p! < reported[i - 1]!)).toBe(true);
  });

  test('legacy stream: the headline is the newest status label and the detail the latest action', () => {
    const now = deriveNow(legacyStreamWorker.milestones, { status: 'running', currentAction: null, prUrl: null, startMs: null, nowMs: 0 });
    expect(now.headline).toBe(LEGACY_LATEST_HEADLINE);
    expect(now.detail?.target).toBe('http.ts');
    // Observed lifecycle from checkpoints, not from the number.
    expect(now.evidence.phases.filter(s => s.state === 'done').map(s => s.key)).toEqual(['claimed', 'started', 'changed', 'committed']);
  });

  test('research task carries no edit, commit or PR fact', () => {
    expect(researchWorker.milestones.some(m => m.type === 'checkpoint' && /edit|commit/.test(m.event))).toBe(false);
    expect(researchWorker.milestones.some(m => m.type === 'action' && m.tool !== 'Read' && m.tool !== 'Bash')).toBe(false);
    expect(researchWorker.prUrl).toBeNull();
    expect(researchWorker.commitCount).toBeNull();
  });

  test('steering covers each delivery state once', () => {
    const live = steeringLiveWorker.instructionHistory.filter(e => e.type === 'instruction');
    expect(live.map(e => e.deliveryState).sort()).toEqual(['acknowledged', 'delivered', 'pending']);
    expect(live.map(e => e.message).sort()).toEqual([STEERING_MESSAGES.acknowledged, STEERING_MESSAGES.delivered, STEERING_MESSAGES.queued].sort());
    // Undelivered is derived, never stored: still pending on an ended worker.
    expect(steeringEndedWorker.status).toBe('completed');
    expect(steeringEndedWorker.instructionHistory).toEqual([expect.objectContaining({ message: STEERING_MESSAGES.undelivered, deliveryState: 'pending' })]);
  });

  test('every attempt worker shares one createdAt, and the flip changes only status', () => {
    const all = [...attemptTie.own, ...attemptTie.attempts.flatMap(a => a.workers)];
    expect(all.length).toBe(3);
    expect(new Set(all.map(w => w.createdAt.getTime()))).toEqual(new Set([ATTEMPT_TIE_AT.getTime()]));
    const flipped = withFlippedStatus(attemptTie, ATTEMPT_FLIP);
    const after = [...flipped.own, ...flipped.attempts.flatMap(a => a.workers)];
    expect(after.map(w => w.id)).toEqual(all.map(w => w.id));
    expect(after.find(w => w.id === ATTEMPT_FLIP.id)?.status).toBe(ATTEMPT_FLIP.to);
    expect(all.find(w => w.id === ATTEMPT_FLIP.id)?.status).toBe(ATTEMPT_FLIP.from);
  });
});
