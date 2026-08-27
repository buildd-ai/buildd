import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock notify module before importing the module under test
const mockNotifyTeam = mock(async () => {});
mock.module('@/lib/notify', () => ({
  notifyTeam: mockNotifyTeam,
}));

import {
  buildConnectorBlockMessage,
  notifyConnectorBlocked,
  notifyConnectorBlockReminder,
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
});
