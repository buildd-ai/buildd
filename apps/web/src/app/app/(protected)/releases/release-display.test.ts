import { describe, expect, it } from 'bun:test';
import { STATES } from '@/components/ui/states';
import { pickNextRelease, releaseCountLine, releasePill, supersededById } from './release-display';

describe('releasePill', () => {
  it('reads a superseded release as neutral Superseded, never red Failed', () => {
    const pill = releasePill({ state: 'failed', failureReason: 'superseded by release newer (PR merged)' });
    expect(pill.label).toBe('Superseded');
    expect(STATES[pill.state].tone).toBe('q');
  });

  it('keeps an ordinary failure red', () => {
    const pill = releasePill({ state: 'failed', failureReason: 'Deployment failed' });
    expect(pill.label).toBe('Failed');
    expect(STATES[pill.state].tone).toBe('bad');
  });

  it('maps every release state to a sentence-case word', () => {
    for (const state of ['pending_external', 'dispatched', 'deploying', 'healthy', 'degraded', 'failed']) {
      const { label } = releasePill({ state, failureReason: null });
      expect(label).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('keeps an unknown state word on a neutral pill', () => {
    const pill = releasePill({ state: 'mystery', failureReason: null });
    expect(pill.label).toBe('mystery');
    expect(STATES[pill.state].tone).toBe('q');
  });
});

describe('supersededById', () => {
  it('parses the successor id and ignores anything else', () => {
    expect(supersededById('superseded by release abc (x)')).toBe('abc');
    expect(supersededById('Deployment failed')).toBeNull();
    expect(supersededById(null)).toBeNull();
  });
});

describe('pickNextRelease', () => {
  const row = (id: string, state: string, workspaceId = 'ws') => ({ id, state, workspaceId });

  it('picks the newest in-flight release', () => {
    expect(pickNextRelease([row('a', 'pending_external'), row('b', 'healthy')])?.id).toBe('a');
    expect(pickNextRelease([row('a', 'dispatched')])?.id).toBe('a');
    expect(pickNextRelease([row('a', 'deploying')])?.id).toBe('a');
  });

  it('is null when the newest release has finished', () => {
    expect(pickNextRelease([row('a', 'healthy'), row('b', 'pending_external')])).toBeNull();
    expect(pickNextRelease([row('a', 'failed')])).toBeNull();
    expect(pickNextRelease([])).toBeNull();
  });

  it('looks at each workspace head when the list spans several', () => {
    const rows = [row('a', 'healthy', 'one'), row('b', 'pending_external', 'two'), row('c', 'dispatched', 'one')];
    expect(pickNextRelease(rows)?.id).toBe('b');
  });
});

describe('releaseCountLine', () => {
  it('says the real total, and that the list is truncated', () => {
    expect(releaseCountLine(1, 1)).toBe('1 release');
    expect(releaseCountLine(7, 7)).toBe('7 releases');
    expect(releaseCountLine(100, 250)).toBe('Latest 100 of 250 releases');
  });
});
