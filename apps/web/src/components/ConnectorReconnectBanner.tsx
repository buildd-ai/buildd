'use client';

import Link from 'next/link';
import { useConnectorReconnect } from './ConnectorReconnectProvider';

export default function ConnectorReconnectBanner() {
  const { expired, dismiss } = useConnectorReconnect();

  if (!expired) return null;

  return (
    <div
      data-testid="connector-reconnect-banner"
      className="bg-status-error/10 border-b border-status-error/20 px-4 py-2"
    >
      <div className="flex items-center justify-center gap-3 text-sm">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-error opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-status-error" />
        </span>
        <span className="text-status-error font-medium">
          <span className="font-semibold">{expired.connectorName}</span> needs to reconnect
        </span>
        <Link
          href={`/app/connections?reconnect=${expired.connectorId}`}
          className="px-2 py-0.5 rounded text-xs font-medium bg-status-error text-white hover:bg-status-error/80 transition-colors"
          onClick={dismiss}
        >
          Reconnect
        </Link>
        <button
          onClick={dismiss}
          className="text-status-error/60 hover:text-status-error transition-colors text-xs"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
