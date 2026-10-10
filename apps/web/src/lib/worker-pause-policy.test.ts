import { describe, it, expect } from 'bun:test';
import { pauseRefusal, pauseServed } from './worker-pause-policy';

describe('pauseServed', () => {
  it('serves a pending pause only to a running worker', () => {
    const at = new Date();
    expect(pauseServed({ status: 'running', pauseRequestedAt: at })).toBe(true);
    expect(pauseServed({ status: 'waiting_input', pauseRequestedAt: at })).toBe(false);
    expect(pauseServed({ status: 'running', pauseRequestedAt: null })).toBe(false);
    expect(pauseServed(null)).toBe(false);
  });
});

describe('pauseRefusal', () => {
  it('allows a running runner-backed worker', () => {
    expect(pauseRefusal({ status: 'running', runner: 'coder' })).toBeNull();
  });
  it('refuses a question-waiting worker as not running, a paused one as already paused', () => {
    expect(pauseRefusal({ status: 'waiting_input', waitingFor: { type: 'question' } })?.code).toBe('not_running');
    expect(pauseRefusal({ status: 'waiting_input', waitingFor: { type: 'pause' } })?.code).toBe('already_paused');
  });
});
