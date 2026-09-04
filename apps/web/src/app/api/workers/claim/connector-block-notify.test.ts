import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock notify module before importing the module under test
const mockNotifyTeam = mock(async () => {});
mock.module('@/lib/notify', () => ({
  notifyTeam: mockNotifyTeam,
}));

import {
  buildConnectorBlockMessage,
  buildConnectorExpiryMessage,
  notifyConnectorBlocked,
  notifyConnectorBlockReminder,
  notifyConnectorExpiry,
  CONNECTOR_BLOCK_REMINDER_MS,
  type ConnectorBlockContext,
} from './connector-block-notify';

const BASE_CTX: ConnectorBlockContext = {
  teamId: 'team-123',
  taskTitle: 'Build feature X',
  workspaceName: 'my-workspace',
  roleSlug: 'builder',
  failures: [{ connectorId: 'conn-1', connectorName: 'GitHub', mode: 'expired_or_revoked' }],
};

afterEach(() => {
  mockNotifyTeam.mockClear();
});

describe('buildConnectorBlockMessage', () => {
  it('formats the canonical message with / separators', () => {
    const msg = buildConnectorBlockMessage('My Task', 'ws-name', 'builder', [
      { connectorId: 'c1', connectorName: 'GitHub', mode: 'expired_or_revoked' },
    ]);
    expect(msg).toContain('Task: "My Task" (workspace: ws-name)');
    expect(msg).toContain('Role: builder | Connector: GitHub (expired_or_revoked)');
    expect(msg).toContain('Fix:');
    expect(msg.split(' / ').length).toBe(3);
  });

  it('includes all failing connectors when multiple', () => {
    const msg = buildConnectorBlockMessage('T', 'W', 'r', [
      { connectorId: 'c1', connectorName: 'GitHub', mode: 'expired_or_revoked' },
      { connectorId: 'c2', connectorName: 'Linear', mode: 'never_mounted' },
    ]);
    expect(msg).toContain('GitHub (expired_or_revoked), Linear (never_mounted)');
  });
});

describe('notifyConnectorBlocked', () => {
  it('fires notification on first block', async () => {
    const sent = await notifyConnectorBlocked(BASE_CTX, false);
    expect(sent).toBe(true);
    expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
    const [teamId, event] = mockNotifyTeam.mock.calls[0];
    expect(teamId).toBe('team-123');
    expect(event).toBe('connectorBlocked');
  });

  it('dedup: does not fire when alreadySent=true', async () => {
    const sent = await notifyConnectorBlocked(BASE_CTX, true);
    expect(sent).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('does not fire when there are no failures', async () => {
    const sent = await notifyConnectorBlocked({ ...BASE_CTX, failures: [] }, false);
    expect(sent).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('title matches spec prefix', async () => {
    await notifyConnectorBlocked(BASE_CTX, false);
    const payload = mockNotifyTeam.mock.calls[0][2];
    expect(payload.title).toBe('[buildd] Task blocked: connector unavailable');
  });

  it('message includes all spec fields', async () => {
    await notifyConnectorBlocked(BASE_CTX, false);
    const payload = mockNotifyTeam.mock.calls[0][2];
    expect(payload.message).toContain('Build feature X');
    expect(payload.message).toContain('my-workspace');
    expect(payload.message).toContain('builder');
    expect(payload.message).toContain('GitHub');
    expect(payload.message).toContain('expired_or_revoked');
    expect(payload.message).toContain('Fix:');
  });
});

describe('notifyConnectorBlockReminder', () => {
  it('does not fire before 30-minute threshold', async () => {
    const justNow = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const sent = await notifyConnectorBlockReminder(BASE_CTX, justNow, false);
    expect(sent).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('fires after 30-minute threshold', async () => {
    const thirtyOneMinAgo = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS - 60_000);
    const sent = await notifyConnectorBlockReminder(BASE_CTX, thirtyOneMinAgo, false);
    expect(sent).toBe(true);
    expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
    const [teamId, event] = mockNotifyTeam.mock.calls[0];
    expect(teamId).toBe('team-123');
    expect(event).toBe('connectorBlocked');
  });

  it('dedup: does not fire when reminderAlreadySent=true', async () => {
    const thirtyOneMinAgo = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS - 60_000);
    const sent = await notifyConnectorBlockReminder(BASE_CTX, thirtyOneMinAgo, true);
    expect(sent).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('does not fire when there are no failures', async () => {
    const thirtyOneMinAgo = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS - 60_000);
    const sent = await notifyConnectorBlockReminder({ ...BASE_CTX, failures: [] }, thirtyOneMinAgo, false);
    expect(sent).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('reminder title indicates it is a follow-up', async () => {
    const thirtyOneMinAgo = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS - 60_000);
    await notifyConnectorBlockReminder(BASE_CTX, thirtyOneMinAgo, false);
    const payload = mockNotifyTeam.mock.calls[0][2];
    expect(payload.title).toContain('Reminder');
    expect(payload.message).toContain('Blocked for');
  });

  it('fires exactly AT the threshold, not one millisecond before', async () => {
    // The existing cases sat at 5 min and 31 min, so `elapsed < THRESHOLD` →
    // `<=` was invisible, and so was widening the window itself (30 min → 30 h,
    // which simply means the reminder never arrives). The reminder is the only
    // second chance the operator gets: the first alert can be missed, and the
    // hourly cron that drives this has exactly one shot per hour.
    const atThreshold = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS);
    expect(await notifyConnectorBlockReminder(BASE_CTX, atThreshold, false)).toBe(true);

    mockNotifyTeam.mockClear();
    const justUnder = new Date(Date.now() - CONNECTOR_BLOCK_REMINDER_MS + 1_000);
    expect(await notifyConnectorBlockReminder(BASE_CTX, justUnder, false)).toBe(false);
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('reports the blocked duration in real minutes', async () => {
    // `Blocked for` alone passed while the number was computed in seconds and
    // labelled minutes — the alert would claim a 45-minute block had lasted
    // 2700 minutes, and the operator's first move is to judge urgency by it.
    const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000);
    await notifyConnectorBlockReminder(BASE_CTX, fortyFiveMinAgo, false);
    const payload = mockNotifyTeam.mock.calls[0][2];
    expect(payload.message).toContain('Blocked for 45 minutes');
  });
});

// ── Proactive expiry alerts ───────────────────────────────────────────────────
//
// `buildConnectorExpiryMessage` and `notifyConnectorExpiry` had no tests at
// all: every mutation to them was silent, including making notifyConnectorExpiry
// return true without sending anything. This is the only alert for a connector
// no task happens to require yet — if it silently stops, the credential rots
// until a task trips over it, which is exactly the reactive path this pair was
// added to get ahead of.

describe('buildConnectorExpiryMessage', () => {
  const NOW = new Date('2026-09-04T12:00:00.000Z');

  it('names the refresh failure when refresh itself is what broke', () => {
    const msg = buildConnectorExpiryMessage(
      {
        teamId: 'team-1',
        connectorName: 'Acme',
        tokenExpiresAt: new Date('2026-09-04T06:00:00.000Z'),
        refreshError: 'invalid_grant',
      },
      NOW,
    );
    // refreshError wins over the expiry clause — it is the actionable cause.
    expect(msg).toContain('token refresh failed (invalid_grant)');
    expect(msg).not.toContain('expired');
    expect(msg).toContain('"Acme" needs re-authorising');
  });

  it('reports how long ago the token expired, in hours', () => {
    const msg = buildConnectorExpiryMessage(
      {
        teamId: 'team-1',
        connectorName: 'Acme',
        tokenExpiresAt: new Date('2026-09-04T09:00:00.000Z'),
      },
      NOW,
    );
    expect(msg).toContain('expired 3h ago and has not renewed');
  });

  it('floors a sub-hour expiry at 1h rather than reporting "0h ago"', () => {
    const msg = buildConnectorExpiryMessage(
      {
        teamId: 'team-1',
        connectorName: 'Acme',
        tokenExpiresAt: new Date('2026-09-04T11:50:00.000Z'),
      },
      NOW,
    );
    expect(msg).toContain('expired 1h ago');
  });

  it('falls back to "is no longer usable" with neither signal', () => {
    const msg = buildConnectorExpiryMessage(
      { teamId: 'team-1', connectorName: 'Acme', tokenExpiresAt: null },
      NOW,
    );
    expect(msg).toContain('is no longer usable');
  });

  it('points the operator at /app/connections, where reconnect lives', () => {
    const msg = buildConnectorExpiryMessage(
      { teamId: 'team-1', connectorName: 'Acme', tokenExpiresAt: null },
      NOW,
    );
    expect(msg).toMatch(/Fix: https?:\/\/[^\s]*\/app\/connections$/);
  });
});

describe('notifyConnectorExpiry', () => {
  it('actually sends the alert to the team', async () => {
    const sent = await notifyConnectorExpiry({
      teamId: 'team-123',
      connectorName: 'Acme',
      tokenExpiresAt: null,
      refreshError: 'invalid_grant',
    });

    expect(sent).toBe(true);
    expect(mockNotifyTeam).toHaveBeenCalledTimes(1);
    const [teamId, event, payload] = mockNotifyTeam.mock.calls[0];
    expect(teamId).toBe('team-123');
    // Same notification channel as the reactive alerts — a new event name would
    // route to a channel nobody has enabled.
    expect(event).toBe('connectorBlocked');
    expect(payload.title).toBe('[buildd] Connection needs reconnecting');
    expect(payload.message).toContain('invalid_grant');
    expect(payload.url).toContain('/app/connections');
  });
});
