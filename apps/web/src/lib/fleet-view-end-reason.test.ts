import { describe, expect, it } from 'bun:test';
import { runEndReason } from './fleet-view-end-reason';

describe('runEndReason', () => {
  it('a live run says what it is doing', () => {
    expect(runEndReason({ status: 'running' })).toBe('Working');
    expect(runEndReason({ status: 'waiting_input' })).toBe('Needs input');
    expect(runEndReason({ status: 'waiting_input', waitingFor: { type: 'pause' } })).toBe('Paused');
  });

  it('a finished run names its PR and whether it merged', () => {
    expect(runEndReason({ status: 'completed' })).toBe('Done');
    expect(runEndReason({ status: 'completed', prNumber: 12 })).toBe('Done · PR #12 open');
    expect(runEndReason({ status: 'completed', prNumber: 12, mergedAt: '2026-10-09T12:00:00Z' })).toBe('Done · merged as #12');
  });

  it('a session-limit stop with its work kept never reads as failed, and names the PR that later merged', () => {
    const error = "You've hit your session limit · resets 8pm (UTC) [work preserved: origin/buildd/abc@123]";
    expect(runEndReason({ status: 'failed', error })).toBe('Stopped: session limit · work kept');
    expect(runEndReason({ status: 'failed', error, taskMergedPr: 4235 })).toBe('Stopped: session limit · work kept · merged as #4235');
    expect(runEndReason({ status: 'error', error: 'error_max_budget_usd reached' })).toBe('Stopped: budget limit');
  });

  it('a paused or superseded run says so', () => {
    expect(runEndReason({ status: 'paused' })).toBe('Paused');
    expect(runEndReason({ status: 'superseded' })).toBe('Superseded by another run');
    expect(runEndReason({ status: 'superseded', taskMergedPr: 5 })).toBe('Superseded · merged as #5');
  });

  it('a cancelled run says so', () => {
    expect(runEndReason({ status: 'failed', error: 'Aborted by user' })).toBe('Cancelled');
    expect(runEndReason({ status: 'cancelled' })).toBe('Cancelled');
  });

  it('a real failure says what kind, and notes a later merge of the same task', () => {
    expect(runEndReason({ status: 'failed', error: 'assertion failed: expected 2' })).toBe('Failed: code or tests');
    expect(runEndReason({ status: 'failed', error: 'ECONNRESET while pushing' })).toBe('Failed: network or capacity');
    expect(runEndReason({ status: 'failed', error: 'command not found: bun' })).toBe('Failed: environment');
    expect(runEndReason({ status: 'failed', error: 'something odd' })).toBe('Failed');
    expect(runEndReason({ status: 'failed', error: 'something odd', taskMergedPr: 7 })).toBe('Failed · the task later merged as #7');
  });

  it('never prints the raw error text', () => {
    const r = runEndReason({ status: 'failed', error: 'SELECT secret FROM users WHERE id = 1' });
    expect(r).not.toContain('SELECT');
  });
});
