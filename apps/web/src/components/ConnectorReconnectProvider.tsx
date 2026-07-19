'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

interface ExpiredConnector {
  workerId: string;
  connectorId: string;
  connectorName: string;
}

interface ConnectorReconnectContextValue {
  expired: ExpiredConnector | null;
  dismiss: () => void;
}

const ConnectorReconnectContext = createContext<ConnectorReconnectContextValue>({
  expired: null,
  dismiss: () => {},
});

export function useConnectorReconnect() {
  return useContext(ConnectorReconnectContext);
}

interface Props {
  workspaceIds: string[];
  children: React.ReactNode;
}

export function ConnectorReconnectProvider({ workspaceIds, children }: Props) {
  const [expired, setExpired] = useState<ExpiredConnector | null>(null);

  const workspaceIdsKey = workspaceIds.join(',');
  useEffect(() => {
    if (!workspaceIdsKey) return;

    const channelNames = workspaceIds.map(id => `${CHANNEL_PREFIX}workspace-${id}`);

    const handleEvent = (data: { workerId?: string; connectorId?: string; connectorName?: string }) => {
      if (data.connectorId && data.connectorName) {
        setExpired({
          workerId: data.workerId ?? '',
          connectorId: data.connectorId,
          connectorName: data.connectorName,
        });
      }
    };

    for (const channelName of channelNames) {
      const channel = subscribeToChannel(channelName);
      if (channel) {
        channel.bind('worker:connector-auth-expired', handleEvent);
      }
    }

    return () => {
      for (const channelName of channelNames) {
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey]);

  return (
    <ConnectorReconnectContext.Provider value={{ expired, dismiss: () => setExpired(null) }}>
      {children}
    </ConnectorReconnectContext.Provider>
  );
}
