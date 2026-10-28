import { describe, expect, test } from 'bun:test';
import { PULSE_STATE_LABEL } from './MissionPulse';
import { runOutcome } from '../fleet/runner-lanes';
import { STATES } from '../ui/states';

describe('status words come from the shared table', () => {
  test('pulse labels are the shared words, lower-cased', () => {
    expect(PULSE_STATE_LABEL.needs_you).toBe(STATES.needs_you.word.toLowerCase());
    expect(PULSE_STATE_LABEL.moving).toBe(STATES.running.word.toLowerCase());
    expect(PULSE_STATE_LABEL.queued).toBe(STATES.ready.word.toLowerCase());
    expect(PULSE_STATE_LABEL.done).toBe('done');
    expect(PULSE_STATE_LABEL.failed).toBe('failed');
    expect(PULSE_STATE_LABEL.skipped).toBe('cancelled');
  });

  test('lane outcome falls back to the shared word', () => {
    expect(runOutcome({ state: 'running', endReason: null })).toBe(STATES.running.word);
    expect(runOutcome({ state: 'waiting', endReason: null })).toBe(STATES.waiting.word);
    expect(runOutcome({ state: 'done', endReason: null })).toBe('Done');
    expect(runOutcome({ state: 'failed', endReason: 'timed out' })).toBe('timed out');
  });
});
