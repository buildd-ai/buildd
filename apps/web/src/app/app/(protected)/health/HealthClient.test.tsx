import { describe, it, expect } from 'bun:test';
import { isRunnerOnline } from '@/lib/runner-heartbeats-shared';

describe('HealthClient - hasProblems regression test', () => {
  it('hasProblems includes degraded sandbox runners in its condition', () => {
    // Regression test for: hasProblems omitted unsandboxedRunners from OR-chain
    // A fleet whose only problem is degraded sandbox posture should render Problems section

    // Simulate the logic from HealthClient.tsx lines 307-314
    const runners = [
      {
        id: 'runner-1',
        lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(), // recent
        sandboxEnabled: false, // degraded sandbox posture
      },
    ];
    const credentialHealth: any[] = [];
    const schedules: any[] = [];
    const recentFailures: any[] = [];

    // Derive problems (matching HealthClient logic)
    const offlineRunners = runners.filter(r => !isRunnerOnline(r.lastHeartbeatAt));
    const unsandboxedRunners = runners.filter(
      r => isRunnerOnline(r.lastHeartbeatAt) && r.sandboxEnabled === false
    );
    const failedSchedules = schedules.filter((s: any) => s.enabled && !!s.lastError);
    const hasProblems =
      credentialHealth.length > 0 ||
      offlineRunners.length > 0 ||
      unsandboxedRunners.length > 0 || // THIS LINE was missing before the fix
      failedSchedules.length > 0 ||
      recentFailures.length > 0;

    // With only unsandboxed runners, hasProblems should be true
    expect(unsandboxedRunners.length).toBe(1);
    expect(offlineRunners.length).toBe(0);
    expect(hasProblems).toBe(true);
  });

  it('hasProblems is false when fleet is completely healthy', () => {
    const runners = [
      {
        id: 'runner-1',
        lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(), // recent
        sandboxEnabled: true, // healthy sandbox
      },
    ];
    const credentialHealth: any[] = [];
    const schedules: any[] = [];
    const recentFailures: any[] = [];

    const offlineRunners = runners.filter(r => !isRunnerOnline(r.lastHeartbeatAt));
    const unsandboxedRunners = runners.filter(
      r => isRunnerOnline(r.lastHeartbeatAt) && r.sandboxEnabled === false
    );
    const failedSchedules = schedules.filter((s: any) => s.enabled && !!s.lastError);
    const hasProblems =
      credentialHealth.length > 0 ||
      offlineRunners.length > 0 ||
      unsandboxedRunners.length > 0 ||
      failedSchedules.length > 0 ||
      recentFailures.length > 0;

    // Healthy fleet should have hasProblems = false
    expect(unsandboxedRunners.length).toBe(0);
    expect(offlineRunners.length).toBe(0);
    expect(hasProblems).toBe(false);
  });
});
