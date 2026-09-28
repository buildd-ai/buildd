/**
 * Is a browser-capable runner online for a workspace?
 * (docs/design/visual-qa-human-review.md, "Runner availability"). Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import { CAPABILITY_BROWSER } from '@buildd/shared';
import { RUNNER_ONLINE_WINDOW_MS } from './runner-heartbeats-shared';
import { browserRunnerOnline, type BrowserRunnerHeartbeat } from './visual-audit-runner';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const hb = (over: Partial<BrowserRunnerHeartbeat> = {}): BrowserRunnerHeartbeat => ({
  lastHeartbeatAt: new Date(NOW - 30_000).toISOString(),
  environment: { envKeys: ['node', CAPABILITY_BROWSER] },
  workspaceIds: ['ws-1'],
  ...over,
});

describe('browserRunnerOnline', () => {
  it('is true for a fresh heartbeat that covers the workspace and advertises a browser', () => {
    expect(browserRunnerOnline([hb()], 'ws-1', NOW)).toBe(true);
    expect(browserRunnerOnline([hb({ lastHeartbeatAt: new Date(NOW - 30_000) })], 'ws-1', NOW)).toBe(true);
  });

  it('is false for a stale heartbeat', () => {
    expect(browserRunnerOnline([hb({ lastHeartbeatAt: new Date(NOW - RUNNER_ONLINE_WINDOW_MS - 1).toISOString() })], 'ws-1', NOW)).toBe(false);
  });

  it('is false when envKeys has no browser, or there is no environment', () => {
    expect(browserRunnerOnline([hb({ environment: { envKeys: ['node', 'docker'] } })], 'ws-1', NOW)).toBe(false);
    expect(browserRunnerOnline([hb({ environment: null })], 'ws-1', NOW)).toBe(false);
    expect(browserRunnerOnline([hb({ environment: {} })], 'ws-1', NOW)).toBe(false);
  });

  it('is false when the runner does not cover the workspace', () => {
    expect(browserRunnerOnline([hb({ workspaceIds: ['ws-2'] })], 'ws-1', NOW)).toBe(false);
    expect(browserRunnerOnline([hb({ workspaceIds: [] })], 'ws-1', NOW)).toBe(false);
  });

  it('needs only one qualifying runner among many', () => {
    expect(browserRunnerOnline([hb({ workspaceIds: ['ws-2'] }), hb({ environment: null }), hb()], 'ws-1', NOW)).toBe(true);
    expect(browserRunnerOnline([], 'ws-1', NOW)).toBe(false);
  });
});
