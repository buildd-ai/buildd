'use client';

import { useState, useEffect, useCallback } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import AddConnectionModal from './AddConnectionModal';

interface Connector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
}

function StatusBadge({ authMode, status }: { authMode: Connector['authMode']; status: Connector['status'] }) {
  if (authMode === 'none') {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-mono bg-status-info/10 text-status-info border border-status-info/30">
        No auth
      </span>
    );
  }
  if (status === 'connected') {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-mono bg-status-success/10 text-status-success border border-status-success/30">
        Connected
      </span>
    );
  }
  if (status === 'expired') {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-mono bg-status-warning/10 text-status-warning border border-status-warning/30">
        Expired
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded font-mono bg-surface-3 text-text-muted border border-border-default">
      Not connected
    </span>
  );
}

function truncateUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen) + '…';
}

export default function ConnectionsClient({
  connectedId,
  errorMsg,
}: {
  connectedId?: string;
  errorMsg?: string;
}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingHeaderConnector, setEditingHeaderConnector] = useState<Connector | null>(null);
  const [headerKeyValue, setHeaderKeyValue] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connector | null>(null);
  const [disconnectLoading, setDisconnectLoading] = useState(false);
  const [deleting, setDeleting] = useState<Connector | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadConnectors = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors');
      if (res.ok) {
        const data = await res.json();
        setConnectors(data.connectors || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConnectors();
  }, [loadConnectors]);

  // Show toast on OAuth redirect params
  useEffect(() => {
    if (connectedId) {
      setMessage({ type: 'success', text: 'Connection established successfully.' });
    } else if (errorMsg) {
      setMessage({ type: 'error', text: `OAuth error: ${errorMsg.replace(/_/g, ' ')}` });
    }
  }, [connectedId, errorMsg]);

  async function handleConnect(connector: Connector) {
    setConnecting(connector.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/connect`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        window.location.href = data.authorizationUrl;
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to start OAuth flow' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to start OAuth flow' });
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnect() {
    if (!disconnecting) return;
    setDisconnectLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${disconnecting.id}/disconnect`, { method: 'POST' });
      if (res.ok) {
        setMessage({ type: 'success', text: `Disconnected ${disconnecting.name}` });
        setDisconnecting(null);
        loadConnectors();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Disconnect failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to disconnect' });
    } finally {
      setDisconnectLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${deleting.id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: 'success', text: `Deleted ${deleting.name}` });
        setDeleting(null);
        loadConnectors();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Delete failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to delete connector' });
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleSaveHeaderKey() {
    if (!editingHeaderConnector || !headerKeyValue.trim()) return;
    setSavingKey(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${editingHeaderConnector.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ headerValue: headerKeyValue.trim() }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: `API key saved for ${editingHeaderConnector.name}` });
        setEditingHeaderConnector(null);
        setHeaderKeyValue('');
        loadConnectors();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to save key' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save key' });
    } finally {
      setSavingKey(false);
    }
  }

  function handleAdded(connector: Connector) {
    setShowAddModal(false);
    loadConnectors();
    if (connector.authMode === 'oauth') {
      handleConnect(connector);
    }
  }

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary font-sans">Connections</h1>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors"
        >
          Add connection
        </button>
      </div>

      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          message.type === 'success'
            ? 'bg-status-success/10 text-status-success border border-status-success/30'
            : 'bg-status-error/10 text-status-error border border-status-error/30'
        }`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="text-text-secondary text-sm">Loading...</div>
      ) : connectors.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-text-muted text-sm mb-3">No connections yet.</p>
          <p className="text-text-muted text-xs mb-4">Add a remote MCP server to get started.</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-sm text-primary hover:underline"
          >
            Add connection
          </button>
        </div>
      ) : (
        <div className="card divide-y divide-border-default">
          {connectors.map((connector) => (
            <div key={connector.id} className="p-4">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-medium text-text-primary">{connector.name}</span>
                    <StatusBadge authMode={connector.authMode} status={connector.status} />
                  </div>
                  <div className="text-xs text-text-secondary font-mono break-all">
                    {truncateUrl(connector.url)}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                  {connector.authMode === 'oauth' && connector.status === 'expired' && (
                    <button
                      onClick={() => handleConnect(connector)}
                      disabled={connecting === connector.id}
                      className="px-3 py-1.5 text-sm bg-status-warning/10 text-status-warning border border-status-warning/30 rounded-md hover:bg-status-warning/20 disabled:opacity-50 transition-colors"
                    >
                      {connecting === connector.id ? 'Redirecting…' : 'Reconnect'}
                    </button>
                  )}
                  {connector.authMode === 'oauth' && connector.status === 'not_connected' && (
                    <button
                      onClick={() => handleConnect(connector)}
                      disabled={connecting === connector.id}
                      className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3 disabled:opacity-50 transition-colors"
                    >
                      {connecting === connector.id ? 'Redirecting…' : 'Connect'}
                    </button>
                  )}
                  {connector.authMode === 'header' && connector.status === 'not_connected' && (
                    <button
                      onClick={() => { setEditingHeaderConnector(connector); setHeaderKeyValue(''); }}
                      className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3 transition-colors"
                    >
                      Set key
                    </button>
                  )}
                  {(connector.status === 'connected' || connector.status === 'expired') && connector.authMode !== 'none' && (
                    <button
                      onClick={() => setDisconnecting(connector)}
                      className="px-3 py-1.5 text-sm text-text-muted hover:text-status-error rounded-md transition-colors"
                    >
                      Disconnect
                    </button>
                  )}
                  <button
                    onClick={() => setDeleting(connector)}
                    className="px-3 py-1.5 text-sm text-text-muted hover:text-status-error rounded-md transition-colors"
                    title="Delete connector"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddModal && (
        <AddConnectionModal
          onClose={() => setShowAddModal(false)}
          onAdded={handleAdded}
        />
      )}

      {editingHeaderConnector && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setEditingHeaderConnector(null)}
        >
          <div className="bg-surface-2 rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-text-primary mb-4">
              Set API key — {editingHeaderConnector.name}
            </h2>
            <input
              type="password"
              value={headerKeyValue}
              onChange={(e) => setHeaderKeyValue(e.target.value)}
              placeholder="Enter API key"
              autoFocus
              className="w-full px-3 py-2 mb-4 bg-surface-3 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
              onKeyDown={(e) => e.key === 'Enter' && handleSaveHeaderKey()}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setEditingHeaderConnector(null)}
                className="flex-1 px-4 py-2 text-sm text-text-secondary hover:bg-surface-3 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveHeaderKey}
                disabled={savingKey || !headerKeyValue.trim()}
                className="flex-1 px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {savingKey ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!disconnecting}
        title={`Disconnect ${disconnecting?.name}?`}
        message="This will remove the stored token. You can reconnect at any time."
        confirmLabel="Disconnect"
        variant="warning"
        loading={disconnectLoading}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnecting(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name}?`}
        message="This will permanently remove the connector and any stored credentials."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
