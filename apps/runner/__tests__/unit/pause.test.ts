import { describe, expect, it } from 'bun:test';
import {
  PAUSED_ERROR_PREFIX,
  decidePause,
  holdsRunnerSlot,
  isParkedAbortError,
  pauseModeFor,
  pausedWaitingFor,
} from '../../src/pause';

const running = { mode: 'session' as const, status: 'working' as const, hasLiveSession: true, toolInFlight: false };

describe('pauseModeFor', () => {
  it('a host runner pauses by ending the session and keeping it on disk', () => {
    expect(pauseModeFor({ singleTask: false })).toBe('session');
  });
  it('a --once run parks only when resumable runs are on', () => {
    expect(pauseModeFor({ singleTask: true, parkingEnabled: true })).toBe('park');
    expect(pauseModeFor({ singleTask: true, parkingEnabled: false })).toBe('none');
  });
});

describe('decidePause', () => {
  it('pauses now when no tool is executing', () => {
    expect(decidePause(running)).toEqual({ action: 'apply' });
  });
  it('waits for a running tool to finish instead of stopping mid call', () => {
    expect(decidePause({ ...running, toolInFlight: true })).toEqual({ action: 'defer' });
  });
  it('refuses on a runner that cannot resume it (fails closed)', () => {
    expect(decidePause({ ...running, mode: 'none' })).toEqual({ action: 'refuse', reason: 'unavailable' });
  });
  it('refuses a worker that is not running or has no session', () => {
    expect(decidePause({ ...running, status: 'waiting' })).toEqual({ action: 'refuse', reason: 'not_running' });
    expect(decidePause({ ...running, status: 'done' })).toEqual({ action: 'refuse', reason: 'not_running' });
    expect(decidePause({ ...running, hasLiveSession: false })).toEqual({ action: 'refuse', reason: 'no_session' });
  });
  it('a second pause is a no-op refusal', () => {
    expect(decidePause({ ...running, status: 'waiting', waitingFor: { type: 'pause' } })).toEqual({ action: 'refuse', reason: 'already_paused' });
  });
  it('a resumed run can be paused again (its old pause waitingFor is not sticky)', () => {
    expect(decidePause({ ...running, waitingFor: { type: 'pause' } })).toEqual({ action: 'apply' });
  });
});

describe('parked aborts', () => {
  it('a pause and a question both end the session without a failure', () => {
    expect(isParkedAbortError('needs_input: which branch?')).toBe(true);
    expect(isParkedAbortError(`${PAUSED_ERROR_PREFIX} by the owner`)).toBe(true);
    expect(isParkedAbortError('Aborted by user')).toBe(false);
    expect(isParkedAbortError(undefined)).toBe(false);
  });
});

describe('pausedWaitingFor', () => {
  it('is answerable with Resume and says the cache cost', () => {
    const w = pausedWaitingFor();
    expect(w.type).toBe('pause');
    expect(w.options?.[0]?.label).toBe('Resume');
    expect(w.prompt).toMatch(/same session/);
    expect(w.prompt).toMatch(/cache/);
  });
});

describe('holdsRunnerSlot', () => {
  it('a paused worker holds no slot; a question still does', () => {
    expect(holdsRunnerSlot({ status: 'waiting', waitingFor: { type: 'pause' } })).toBe(false);
    expect(holdsRunnerSlot({ status: 'waiting', waitingFor: { type: 'question' } })).toBe(true);
    expect(holdsRunnerSlot({ status: 'working' })).toBe(true);
    expect(holdsRunnerSlot({ status: 'done' })).toBe(false);
  });
});
