'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import DeleteAccountButton from '../accounts/DeleteAccountButton';
import CopyBlock from '@/components/CopyBlock';
import ConfirmDialog from '@/components/ConfirmDialog';
import ApiKeyModal from '@/components/ApiKeyModal';

interface Account {
  id: string;
  name: string;
  type: string;
  authType: string;
  apiKeyPrefix: string | null;
  maxConcurrentWorkers: number;
  totalTasks: number;
  totalCost: string | null;
  activeSessions: number | null;
  maxConcurrentSessions: number | null;
  hasOauthToken?: boolean;
  team: { name: string } | null;
  accountWorkspaces?: { workspaceId: string }[];
}

const typeColors: Record<string, string> = {
  user: 'bg-status-info/10 text-status-info',
  service: 'bg-primary/10 text-primary',
  action: 'bg-status-warning/10 text-status-warning',
};

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
}

export default function ApiKeysSection({ accounts, workspaces = [] }: { accounts: Account[]; workspaces?: Workspace[] }) {
  const router = useRouter();
  const [regenerateTarget, setRegenerateTarget] = useState<Account | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ accountName: string; apiKey: string } | null>(null);
  const [oauthTarget, setOauthTarget] = useState<Account | null>(null);
  const [oauthTokenInput, setOauthTokenInput] = useState('');
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Account | null>(null);

  async function handleRegenerate() {
    if (!regenerateTarget) return;
    setRegenerating(true);
    setRegenerateError(null);

    try {
      const res = await fetch(`/api/accounts/${regenerateTarget.id}/regenerate-key`, {
        method: 'POST',
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to regenerate key');
      }

      const data = await res.json();
      setRegenerateTarget(null);
      setNewKey({ accountName: regenerateTarget.name, apiKey: data.apiKey });
      router.refresh();
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : 'Failed to regenerate key');
    } finally {
      setRegenerating(false);
    }
  }

  async function handleOauthSave() {
    if (!oauthTarget || !oauthTokenInput) return;
    setOauthSaving(true);
    setOauthError(null);

    try {
      const res = await fetch(`/api/accounts/${oauthTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oauthToken: oauthTokenInput }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update token');
      }

      setOauthTarget(null);
      setOauthTokenInput('');
      router.refresh();
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Failed to update token');
    } finally {
      setOauthSaving(false);
    }
  }

  async function handleOauthRevoke() {
    if (!revokeTarget) return;
    setOauthSaving(true);
    setOauthError(null);

    try {
      const res = await fetch(`/api/accounts/${revokeTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revokeOauthToken: true }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to revoke token');
      }

      setRevokeTarget(null);
      router.refresh();
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setOauthSaving(false);
    }
  }

  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-label">API Keys</h2>
        <Link
          href="/app/accounts/new"
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          + New Account
        </Link>
      </div>

      {accounts.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-text-muted text-sm mb-3">No accounts yet</p>
          <Link href="/app/accounts/new" className="text-sm text-primary hover:underline">
            Create an account to get an API key
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="card p-4"
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{account.name}</h3>
                    {account.team?.name && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-surface-3 text-text-secondary">{account.team.name}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${typeColors[account.type]}`}>
                      {account.type}
                    </span>
                    {account.accountWorkspaces && account.accountWorkspaces.length === 0 && (
                      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-status-warning/10 text-status-warning" title="This account has no workspace links. API key won't be able to claim tasks or create tasks in any workspace.">
                        No workspace linked
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-sm text-text-secondary">
                  <div>Workers: {account.maxConcurrentWorkers}</div>
                  <div>Tasks: {account.totalTasks}</div>
                </div>
              </div>

              <div className="bg-surface-3 rounded p-2 font-mono text-sm break-all">
                <code>{account.apiKeyPrefix ? `${account.apiKeyPrefix}...` : '(hashed)'}</code>
              </div>

              {account.authType === 'oauth' && (
                <div className="mt-2 flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full ${
                    account.hasOauthToken
                      ? 'bg-status-success/10 text-status-success'
                      : 'bg-status-warning/10 text-status-warning'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      account.hasOauthToken ? 'bg-status-success' : 'bg-status-warning'
                    }`} />
                    {account.hasOauthToken ? 'Token configured' : 'No token set'}
                  </span>
                  <button
                    onClick={() => {
                      setOauthError(null);
                      setOauthTokenInput('');
                      setOauthTarget(account);
                    }}
                    className="text-text-secondary hover:text-text-primary text-xs"
                  >
                    {account.hasOauthToken ? 'Rotate' : 'Set token'}
                  </button>
                  {account.hasOauthToken && (
                    <button
                      onClick={() => setRevokeTarget(account)}
                      className="text-status-error/70 hover:text-status-error text-xs"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )}

              <div className="mt-2 flex justify-between items-center">
                <span className="text-xs text-text-secondary">
                  Auth: {account.authType} |
                  {account.authType === 'api' && ` Cost: $${account.totalCost}`}
                  {account.authType === 'oauth' && ` Sessions: ${account.activeSessions}/${account.maxConcurrentSessions || '\u221E'}`}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      setRegenerateError(null);
                      setRegenerateTarget(account);
                    }}
                    className="text-text-secondary hover:text-text-primary text-sm"
                  >
                    Regenerate
                  </button>
                  <DeleteAccountButton accountId={account.id} accountName={account.name} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <McpSetupSection apiKey={accounts.find(a => a.apiKeyPrefix)?.apiKeyPrefix ?? null} workspaces={workspaces} />

      {/* Regenerate confirmation dialog */}
      <ConfirmDialog
        open={!!regenerateTarget}
        title="Regenerate API Key?"
        message={regenerateError || `This will invalidate the current key for "${regenerateTarget?.name}". Any workers using the old key will stop working immediately.`}
        confirmLabel="Regenerate"
        variant="warning"
        loading={regenerating}
        onConfirm={handleRegenerate}
        onCancel={() => {
          setRegenerateTarget(null);
          setRegenerateError(null);
        }}
      />

      {/* New key display modal */}
      {newKey && (
        <ApiKeyModal
          open={!!newKey}
          accountName={newKey.accountName}
          apiKey={newKey.apiKey}
          repos={workspaces.filter(w => w.repo).map(w => w.repo!)}
          onClose={() => setNewKey(null)}
        />
      )}

      {/* OAuth token set/rotate dialog */}
      {oauthTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-2 rounded-lg shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <h3 className="text-lg font-semibold">
              {oauthTarget.hasOauthToken ? 'Rotate' : 'Set'} OAuth Token
            </h3>
            <p className="text-sm text-text-secondary">
              {oauthTarget.hasOauthToken
                ? `Enter a new OAuth token for "${oauthTarget.name}". This will replace the existing token.`
                : `Enter the CLAUDE_CODE_OAUTH_TOKEN for "${oauthTarget.name}".`}
            </p>
            {oauthError && (
              <div className="p-3 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error text-sm">
                {oauthError}
              </div>
            )}
            <input
              type="password"
              value={oauthTokenInput}
              onChange={(e) => setOauthTokenInput(e.target.value)}
              placeholder="Paste OAuth token"
              className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setOauthTarget(null);
                  setOauthTokenInput('');
                  setOauthError(null);
                }}
                className="px-4 py-2 text-sm border border-border-default rounded-md hover:bg-surface-3"
              >
                Cancel
              </button>
              <button
                onClick={handleOauthSave}
                disabled={!oauthTokenInput || oauthSaving}
                className="px-4 py-2 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
              >
                {oauthSaving ? 'Saving...' : 'Save Token'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OAuth token revoke confirmation */}
      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke OAuth Token?"
        message={`This will remove the OAuth token from "${revokeTarget?.name}". Workers using this account will lose access to Claude Code until a new token is set.`}
        confirmLabel="Revoke"
        variant="warning"
        loading={oauthSaving}
        onConfirm={handleOauthRevoke}
        onCancel={() => {
          setRevokeTarget(null);
          setOauthError(null);
        }}
      />
    </section>
  );
}

// ── MCP Setup Section ────────────────────────────────────────────────────────

function McpSetupSection({ apiKey, workspaces = [] }: { apiKey: string | null; workspaces?: Workspace[] }) {
  const key = apiKey ? `${apiKey}...` : 'YOUR_API_KEY';
  const reposWithWorkspaces = workspaces.filter(w => w.repo);

  function mcpUrl(repo?: string) {
    const base = 'https://buildd.dev/api/mcp';
    return repo ? `${base}?repo=${repo}` : base;
  }

  function mcpCommand(repo?: string) {
    return `claude mcp add --transport http buildd "${mcpUrl(repo)}" --header "Authorization: Bearer ${key}"`;
  }

  return (
    <div className="mt-4 space-y-3">
      <h3 className="font-medium text-sm">Connect to buildd</h3>

      {reposWithWorkspaces.length > 0 ? (
        reposWithWorkspaces.map(w => (
          <div key={w.id} className="card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">Claude Code</div>
              <span className="text-xs text-text-secondary">· {w.repo}</span>
            </div>
            <CopyBlock text={mcpCommand(w.repo!)} />
          </div>
        ))
      ) : (
        <div className="card p-4 space-y-3">
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">Claude Code</div>
          <CopyBlock text={mcpCommand()} />
        </div>
      )}

      <details className="card p-4">
        <summary className="text-xs font-medium text-text-secondary uppercase tracking-wide cursor-pointer">REST API</summary>
        <div className="mt-3">
          <CopyBlock text={`curl -X POST https://buildd.dev/api/workers/claim \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"maxTasks": 1}'`} />
        </div>
      </details>
    </div>
  );
}
