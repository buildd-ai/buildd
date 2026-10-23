/**
 * Living Spec "Runner updates in minutes" (47c97f48 r1): what a heartbeat row
 * says about an update in progress (R-5 to R-7, AC-4, AC-5, AC-7).
 */
import { describe, expect, it } from 'bun:test';
import {
  UPDATE_RELEASE_SILENCE_MS,
  UPDATE_STOPPED_REASON,
  UPDATE_STUCK_GRACE_MS,
  nextUpdateCheckAt,
  parseUpdateDrain,
  runnerUpdateLine,
  runnerUpdateState,
} from '../src/runner-update';

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T01:13:00Z');

function drain(over: Record<string, unknown> = {}) {
  return {
    since: T0,
    endsAt: T0 + 10 * MIN,
    busy: 1,
    phase: 'draining',
    targetVersion: 'v0.377.0',
    paused: [{ workerId: 'w-long-1234567', taskId: 't-1', title: 'Refactor the claim route', since: T0 + 30_000 }],
    ...over,
  };
}

describe('parseUpdateDrain', () => {
  it('normalises epoch ms to ISO and keeps the paused agents', () => {
    const d = parseUpdateDrain(drain())!;
    expect(d.since).toBe('2026-10-23T01:13:00.000Z');
    expect(d.phase).toBe('draining');
    expect(d.paused).toEqual([{ workerId: 'w-long-1234567', taskId: 't-1', title: 'Refactor the claim route', since: '2026-10-23T01:13:30.000Z' }]);
  });

  it('an older runner (no phase, no paused) reads as draining with nobody paused', () => {
    const d = parseUpdateDrain({ since: T0, endsAt: T0 + 60 * MIN, busy: 4 })!;
    expect(d).toMatchObject({ phase: 'draining', paused: [], busy: 4, targetVersion: null });
  });

  it('junk is null, junk paused entries are dropped, the list is capped', () => {
    expect(parseUpdateDrain(null)).toBeNull();
    expect(parseUpdateDrain({ since: 'soon', endsAt: T0 })).toBeNull();
    const d = parseUpdateDrain(drain({ paused: [null, 7, { title: 'no id' }, ...Array.from({ length: 80 }, (_, i) => ({ workerId: `w-${i}` }))] }))!;
    expect(d.paused).toHaveLength(50);
    expect(d.paused![0].workerId).toBe('w-0');
  });
});

describe('runnerUpdateState', () => {
  it('AC-7: an update in progress reads "Updating to <version>" with the paused agents named', () => {
    const view = runnerUpdateState({ updateDrain: drain({ phase: 'updating', endsAt: T0 + 2 * MIN }), lastHeartbeatAt: new Date(T0 + 2 * MIN) }, T0 + 2 * MIN + 10_000)!;
    expect(view.stuck).toBe(false);
    expect(runnerUpdateLine(view, 'DESKTOP-1')).toBe('Updating to v0.377.0 · Paused for update: "Refactor the claim route"');
  });

  it('no drain on the row: no update', () => {
    expect(runnerUpdateState({ updateDrain: null, lastHeartbeatAt: new Date(T0) }, T0)).toBeNull();
  });

  it('AC-5: a late heartbeat while draining is stuck before the window ends', () => {
    const lastBeat = T0 + 2 * MIN;
    const at = T0 + 6 * MIN; // window ends at T0 + 10m
    const view = runnerUpdateState({ updateDrain: drain(), lastHeartbeatAt: new Date(lastBeat) }, at)!;
    expect(view.stuck).toBe(true);
    expect(runnerUpdateLine(view, 'DESKTOP-1')).toBe('Update stuck on DESKTOP-1 since 2026-10-23T01:15:00.000Z (1 paused agent waiting)');
  });

  it('a draining runner that is beating is not stuck', () => {
    expect(runnerUpdateState({ updateDrain: drain(), lastHeartbeatAt: new Date(T0 + 5 * MIN) }, T0 + 5 * MIN + 30_000)!.stuck).toBe(false);
  });

  it('AC-4: silent while updating, stuck only 15 minutes after the window\'s end, released after 60 minutes', () => {
    const endsAt = T0 + 3 * MIN; // applied early: the window closed at the apply
    const row = { updateDrain: drain({ phase: 'updating', endsAt }), lastHeartbeatAt: new Date(endsAt) };
    expect(runnerUpdateState(row, endsAt + UPDATE_STUCK_GRACE_MS - 1)!.stuck).toBe(false);
    const stuck = runnerUpdateState(row, endsAt + UPDATE_STUCK_GRACE_MS)!;
    expect(stuck.stuck).toBe(true);
    expect(stuck.release).toBe(false);
    expect(runnerUpdateState(row, endsAt + UPDATE_RELEASE_SILENCE_MS)!.release).toBe(true);
    expect(UPDATE_STOPPED_REASON).toBe('runner stopped during an update');
  });

  it('the next look is when it would turn stuck, then when it would be released, then none', () => {
    const endsAt = T0 + 3 * MIN;
    const row = { updateDrain: drain({ phase: 'updating', endsAt }), lastHeartbeatAt: new Date(endsAt) };
    expect(nextUpdateCheckAt(row, endsAt)).toBe(endsAt + UPDATE_STUCK_GRACE_MS);
    expect(nextUpdateCheckAt(row, endsAt + UPDATE_STUCK_GRACE_MS)).toBe(endsAt + UPDATE_RELEASE_SILENCE_MS);
    expect(nextUpdateCheckAt(row, endsAt + UPDATE_RELEASE_SILENCE_MS)).toBeNull();
  });
});
