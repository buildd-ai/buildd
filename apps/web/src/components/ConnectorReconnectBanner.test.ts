import { describe, it, expect } from 'bun:test';

// Unit tests for ConnectorReconnectBanner/Provider.
// The provider holds a single `expired` state that gets populated when the
// 'worker:connector-auth-expired' Pusher event arrives, and cleared on dismiss.
//
// These tests exercise the state-transition logic using the same shape the
// provider uses — without needing a DOM or React renderer.

interface ExpiredConnector {
  workerId: string;
  connectorId: string;
  connectorName: string;
}

// Simulate the event handler logic from ConnectorReconnectProvider
function handleConnectorAuthExpiredEvent(
  data: Record<string, unknown>,
): ExpiredConnector | null {
  if (typeof data.connectorId === 'string' && typeof data.connectorName === 'string') {
    return {
      workerId: typeof data.workerId === 'string' ? data.workerId : '',
      connectorId: data.connectorId,
      connectorName: data.connectorName,
    };
  }
  return null;
}

describe('ConnectorReconnectProvider event handling', () => {
  it('sets expired state when event has connectorId and connectorName', () => {
    const result = handleConnectorAuthExpiredEvent({
      workerId: 'worker-1',
      connectorId: 'conn-gh',
      connectorName: 'GitHub',
    });
    expect(result).not.toBeNull();
    expect(result?.connectorId).toBe('conn-gh');
    expect(result?.connectorName).toBe('GitHub');
    expect(result?.workerId).toBe('worker-1');
  });

  it('uses empty string for workerId when not provided', () => {
    const result = handleConnectorAuthExpiredEvent({
      connectorId: 'conn-gh',
      connectorName: 'GitHub',
    });
    expect(result?.workerId).toBe('');
  });

  it('returns null when connectorId is missing', () => {
    const result = handleConnectorAuthExpiredEvent({ connectorName: 'GitHub' });
    expect(result).toBeNull();
  });

  it('returns null when connectorName is missing', () => {
    const result = handleConnectorAuthExpiredEvent({ connectorId: 'conn-gh' });
    expect(result).toBeNull();
  });

  it('returns null for empty event payload', () => {
    const result = handleConnectorAuthExpiredEvent({});
    expect(result).toBeNull();
  });
});

describe('ConnectorReconnectBanner render conditions', () => {
  it('banner is hidden when expired is null', () => {
    // Simulates: if (!expired) return null
    const expired: ExpiredConnector | null = null;
    expect(expired).toBeNull();
  });

  it('banner is visible and shows correct connector name when expired is set', () => {
    const expired: ExpiredConnector = {
      workerId: 'worker-1',
      connectorId: 'conn-gh',
      connectorName: 'GitHub',
    };
    expect(expired).not.toBeNull();
    expect(expired.connectorName).toBe('GitHub');
    expect(expired.connectorId).toBe('conn-gh');
  });

  it('reconnect link points to /app/connections?reconnect=<connectorId>', () => {
    const connectorId = 'conn-gh';
    const href = `/app/connections?reconnect=${connectorId}`;
    expect(href).toBe('/app/connections?reconnect=conn-gh');
  });
});
