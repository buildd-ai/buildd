import { describe, it, expect } from 'bun:test';
import {
  resolveNotifyPlan,
  isCredentialExpiredError,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotifyEvent,
} from './notify-rules';

const ALL_ON: Record<NotifyEvent, boolean> = { ...DEFAULT_NOTIFICATION_PREFERENCES };

describe('resolveNotifyPlan', () => {
  it('no-ops when no channel is configured (no cross-tenant spam)', () => {
    const plan = resolveNotifyPlan('taskFailed', null, ALL_ON);
    expect(plan.noop).toBe(true);
    expect(plan.pushover).toBe(false);
    expect(plan.webhook).toBe(false);
  });

  it('no-ops when the channel object is empty', () => {
    const plan = resolveNotifyPlan('taskCompleted', {}, ALL_ON);
    expect(plan.noop).toBe(true);
  });

  it('sends to Pushover when a key is set and the event is enabled', () => {
    const plan = resolveNotifyPlan('taskClaimed', { pushover: { userKey: 'uXXXX' } }, ALL_ON);
    expect(plan.noop).toBe(false);
    expect(plan.pushover).toBe(true);
    expect(plan.webhook).toBe(false);
  });

  it('sends to the webhook when a URL is set and the event is enabled', () => {
    const plan = resolveNotifyPlan('taskFailed', { webhookUrl: 'https://x.test/h' }, ALL_ON);
    expect(plan.noop).toBe(false);
    expect(plan.pushover).toBe(false);
    expect(plan.webhook).toBe(true);
  });

  it('sends to both channels when both are configured', () => {
    const plan = resolveNotifyPlan('taskCompleted', { pushover: { userKey: 'u' }, webhookUrl: 'https://x.test/h' }, ALL_ON);
    expect(plan.pushover).toBe(true);
    expect(plan.webhook).toBe(true);
    expect(plan.noop).toBe(false);
  });

  it('no-ops when the event is disabled even if a channel exists', () => {
    const prefs = { ...ALL_ON, taskClaimed: false };
    const plan = resolveNotifyPlan('taskClaimed', { pushover: { userKey: 'u' }, webhookUrl: 'https://x.test/h' }, prefs);
    expect(plan.noop).toBe(true);
    expect(plan.pushover).toBe(false);
    expect(plan.webhook).toBe(false);
  });

  it('still sends an enabled event when a sibling event is disabled ("only failures")', () => {
    const prefs: Record<NotifyEvent, boolean> = {
      taskClaimed: false,
      taskCompleted: false,
      taskFailed: true,
      credentialExpired: true,
    };
    expect(resolveNotifyPlan('taskClaimed', { pushover: { userKey: 'u' } }, prefs).noop).toBe(true);
    expect(resolveNotifyPlan('taskFailed', { pushover: { userKey: 'u' } }, prefs).noop).toBe(false);
    expect(resolveNotifyPlan('credentialExpired', { pushover: { userKey: 'u' } }, prefs).pushover).toBe(true);
  });

  it('treats an empty-string channel value as not configured', () => {
    const plan = resolveNotifyPlan('taskFailed', { pushover: { userKey: '' }, webhookUrl: '' }, ALL_ON);
    expect(plan.noop).toBe(true);
  });
});

describe('DEFAULT_NOTIFICATION_PREFERENCES', () => {
  it('defaults every event on (preserves prior behaviour, now muteable)', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      taskClaimed: true,
      taskCompleted: true,
      taskFailed: true,
      credentialExpired: true,
    });
  });
});

describe('isCredentialExpiredError', () => {
  it('matches the real outage pattern (401 invalid authentication credentials)', () => {
    expect(isCredentialExpiredError('401 Invalid authentication credentials')).toBe(true);
  });

  it('matches expired OAuth and invalid x-api-key cases', () => {
    expect(isCredentialExpiredError('OAuth token has expired')).toBe(true);
    expect(isCredentialExpiredError('invalid x-api-key')).toBe(true);
    expect(isCredentialExpiredError('authentication_error: ...')).toBe(true);
  });

  it('does NOT match buildd\'s own API-key auth errors', () => {
    expect(isCredentialExpiredError('Invalid API key')).toBe(false);
    expect(isCredentialExpiredError('bld_abc123 was rejected')).toBe(false);
  });

  it('does NOT match unrelated failures', () => {
    expect(isCredentialExpiredError('Tests failed: 3 assertions')).toBe(false);
    expect(isCredentialExpiredError('budget limit exceeded')).toBe(false);
    expect(isCredentialExpiredError(undefined)).toBe(false);
    expect(isCredentialExpiredError('')).toBe(false);
  });
});
