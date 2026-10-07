import { describe, expect, it } from 'bun:test';
import {
  CLOUD_DISPATCH_EVENTS,
  WORKSPACE_EXECUTORS,
  isWorkspaceExecutor,
  resolveWorkspaceExecutor,
} from '@buildd/shared';
import { DISPATCH_EVENTS } from '../../../apps/cloud-runner/src/deploy-plan';

const cloudWebhook = { url: 'https://cloud.example/dispatch', enabled: true, events: [...CLOUD_DISPATCH_EVENTS] };

describe('resolveWorkspaceExecutor', () => {
  it('an explicit gitConfig.executor wins, whatever the webhook says', () => {
    for (const value of WORKSPACE_EXECUTORS) {
      expect(resolveWorkspaceExecutor({ executor: value }, cloudWebhook)).toEqual({ executor: value, source: 'explicit' });
    }
  });

  it('derives cloud from an enabled webhook that lists every cloud dispatch event', () => {
    expect(resolveWorkspaceExecutor(null, cloudWebhook)).toEqual({ executor: 'cloud', source: 'dispatch_webhook' });
    // Extra events do not matter.
    expect(resolveWorkspaceExecutor({}, { ...cloudWebhook, events: [...CLOUD_DISPATCH_EVENTS, 'task.other'] }).executor).toBe('cloud');
  });

  it('a disabled webhook, a partial event list or no event list is not a cloud dispatch', () => {
    expect(resolveWorkspaceExecutor(null, { ...cloudWebhook, enabled: false })).toEqual({ executor: 'any', source: 'default' });
    expect(resolveWorkspaceExecutor(null, { ...cloudWebhook, events: ['task.created', 'task.unblocked'] }).executor).toBe('any');
    expect(resolveWorkspaceExecutor(null, { url: 'https://x.example', enabled: true }).executor).toBe('any');
    expect(resolveWorkspaceExecutor(null, null)).toEqual({ executor: 'any', source: 'default' });
    expect(resolveWorkspaceExecutor(undefined, undefined)).toEqual({ executor: 'any', source: 'default' });
  });

  it('a null or unknown stored value falls through to the derivation', () => {
    expect(resolveWorkspaceExecutor({ executor: null }, cloudWebhook)).toEqual({ executor: 'cloud', source: 'dispatch_webhook' });
    expect(resolveWorkspaceExecutor({ executor: 'Cloud' }, null)).toEqual({ executor: 'any', source: 'default' });
  });
});

describe('isWorkspaceExecutor', () => {
  it('accepts exactly cloud, host and any', () => {
    expect(['cloud', 'host', 'any'].every(isWorkspaceExecutor)).toBe(true);
    for (const bad of ['', 'Cloud', 'local', 'runner', null, undefined, 1, true]) expect(isWorkspaceExecutor(bad)).toBe(false);
  });
});

describe('CLOUD_DISPATCH_EVENTS', () => {
  it('matches the cloud runner Worker dispatch set', () => {
    // The derivation reads this list; the Worker registers its own. If they
    // drift, a cloud-dispatched workspace stops being recognised as cloud.
    expect([...CLOUD_DISPATCH_EVENTS].sort()).toEqual([...DISPATCH_EVENTS].sort());
  });
});
