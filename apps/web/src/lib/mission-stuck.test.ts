import { describe, it, expect } from 'bun:test';
import { isMissionStuck, BACKSTOP_GRACE_MS } from './mission-stuck';
import type { HeartbeatPrepassDecision } from './heartbeat-prepass';

const now = new Date('2026-09-28T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

function changed(overrides: Partial<Extract<HeartbeatPrepassDecision, { action: 'invoke_llm' }>> = {}): HeartbeatPrepassDecision {
  return { action: 'invoke_llm', stateKey: 'sk', openTaskCount: 0, planningActive: false, lastOrganizerRunAt: null, ...overrides };
}

describe('isMissionStuck', () => {
  it('grace period is two hours', () => {
    expect(BACKSTOP_GRACE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('a changed state with a recent organizer run is not stuck: the event loop just planned it', () => {
    const verdict = isMissionStuck({ prepass: changed(), lastOrganizerRunAt: ago(30 * 60 * 1000), now });
    expect(verdict).toEqual({ stuck: false, reason: 'recent_organizer_run' });
  });

  it('the same state past the grace period is stuck', () => {
    const verdict = isMissionStuck({ prepass: changed(), lastOrganizerRunAt: ago(BACKSTOP_GRACE_MS + 1), now });
    expect(verdict).toEqual({ stuck: true, reason: 'state_changed_unplanned' });
  });

  it('a mission with no organizer run ever is stuck once the state asks for planning', () => {
    expect(isMissionStuck({ prepass: changed(), lastOrganizerRunAt: null, now }).stuck).toBe(true);
  });

  it('exactly at the grace boundary is still within grace', () => {
    expect(isMissionStuck({ prepass: changed(), lastOrganizerRunAt: ago(BACKSTOP_GRACE_MS), now }).stuck).toBe(false);
  });

  it('open work is not stuck: its completion will re-plan', () => {
    const verdict = isMissionStuck({ prepass: changed({ openTaskCount: 2 }), lastOrganizerRunAt: null, now });
    expect(verdict).toEqual({ stuck: false, reason: 'open_work' });
  });

  it('an active planning task is not stuck', () => {
    const verdict = isMissionStuck({ prepass: changed({ planningActive: true }), lastOrganizerRunAt: null, now });
    expect(verdict).toEqual({ stuck: false, reason: 'planning_active' });
  });

  it('a prepass that did not ask for planning is never stuck', () => {
    for (const prepass of [
      { action: 'skip_no_change', stateKey: 'sk' },
      { action: 'skip_complete' },
      { action: 'skip_blocked', reason: 'r' },
      { action: 'skip_waiting', reason: 'r', waitUntil: now },
    ] as HeartbeatPrepassDecision[]) {
      expect(isMissionStuck({ prepass, lastOrganizerRunAt: null, now })).toEqual({ stuck: false, reason: 'prepass_skipped' });
    }
  });

  it('an unavailable prepass is not stuck (fail closed: events still drive the mission)', () => {
    expect(isMissionStuck({ prepass: null, lastOrganizerRunAt: null, now })).toEqual({ stuck: false, reason: 'prepass_unavailable' });
  });
});
