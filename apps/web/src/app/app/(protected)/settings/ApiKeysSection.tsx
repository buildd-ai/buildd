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
  budgetExhaustedAt: string | null;
  budgetResetsAt: string | null;
  hasOauthToken?: boolean;
  team: { name: string } | null;
  accountWorkspaces?: { workspaceId: string }[];
}

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
}

export default function ApiKeysSection({ accounts, workspaces = [] }: { accounts: Account[]; workspaces?: Workspace[] }) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
        <div className="card divide-y divide-border-default">
          {accounts.map((account) => {
            const isExpanded = expandedId === account.id;
            const hasWarning = account.accountWorkspaces && account.accountWorkspaces.length === 0;

            return (
              <div key={account.id}>
                {/* Compact row */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : account.id)}
                  className="w-full flex items-center gap-3 p-3 hover:bg-surface-3/50 transition-colors text-left first:rounded-t-[10px] last:rounded-b-[10px]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{account.name}</span>
                      {account.team?.name && (
                        <span className="text-[11px] text-text-muted truncate flex-shrink-0">{account.team.name}</span>
                      )}
                      {hasWarning && (
                        <span className="w-1.5 h-1.5 rounded-full bg-status-warning flex-shrink-0" title="No workspace linked" />
                      )}
                    </div>
                  </div>
                  <code className="text-xs text-text-muted font-mono flex-shrink-0">
                    {account.apiKeyPrefix ? `${account.apiKeyPrefix}...` : '—'}
                  </code>
                  <svg className={`w-4 h-4 text-text-muted transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3">
                    <div className="bg-surface-3/50 rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-text-muted">
                        <span>Auth: {account.authType}</span>
                        <span>·</span>
                        <span>Type: {account.type}</span>
                        <span>·</span>
                        <span>Workers: {account.maxConcurrentWorkers}</span>
                        {account.authType === 'api' && (
                          <><span>·</span><span>Cost: ${account.totalCost}</span></>
                        )}
                        {account.authType === 'oauth' && (
                          <><span>·</span><span>Sessions: {account.activeSessions}/{account.maxConcurrentSessions || '\u221E'}</span></>
                        )}
                        {account.budgetExhaustedAt && (
                          <><span>·</span><span className="text-status-error">Budget exhausted{account.budgetResetsAt && ` · Resets ${new Date(account.budgetResetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span></>
                        )}
                      </div>

                      {hasWarning && (
                        <p className="text-xs text-status-warning">No workspace linked — API key can&apos;t claim or create tasks.</p>
                      )}

                      {account.authType === 'oauth' && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className={account.hasOauthToken ? 'text-status-success' : 'text-status-warning'}>
                            {account.hasOauthToken ? 'Token set' : 'No token'}
                          </span>
                          <button
                            onClick={() => { setOauthError(null); setOauthTokenInput(''); setOauthTarget(account); }}
                            className="text-text-secondary hover:text-text-primary"
                          >
                            {account.hasOauthToken ? 'Rotate' : 'Set token'}
                          </button>
                          {account.hasOauthToken && (
                            <button
                              onClick={() => setRevokeTarget(account)}
                              className="text-text-muted hover:text-status-error"
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-3 text-xs">
                        <button
                          onClick={() => { setRegenerateError(null); setRegenerateTarget(account); }}
                          className="text-text-secondary hover:text-text-primary"
                        >
                          Regenerate key
                        </button>
                        <DeleteAccountButton accountId={account.id} accountName={account.name} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MCP setup — collapsed */}
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

// ── MCP Setup Section (collapsed by default) ────────────────────────────

function McpSetupSection({ apiKey, workspaces = [] }: { apiKey: string | null; workspaces?: Workspace[] }) {
  const key = apiKey ? `${apiKey}...` : 'YOUR_API_KEY';
  const reposWithWorkspaces = workspaces.filter(w => w.repo);

  function mcpCommand(repo?: string) {
    const base = 'https://buildd.dev/api/mcp';
    const url = repo ? `${base}?repo=${repo}` : base;
    return `claude mcp add --transport http buildd "${url}" --header "Authorization: Bearer ${key}"`;
  }

  return (
    <details className="mt-4">
      <summary className="text-xs text-text-muted cursor-pointer hover:text-text-secondary">
        Connect to buildd (MCP setup)
      </summary>
      <div className="mt-3 space-y-3">
        {reposWithWorkspaces.length > 0 ? (
          reposWithWorkspaces.map(w => (
            <div key={w.id} className="card p-4 space-y-3">
              <div className="text-xs text-text-muted">{w.repo}</div>
              <CopyBlock text={mcpCommand(w.repo!)} />
            </div>
          ))
        ) : (
          <div className="card p-4 space-y-3">
            <div className="text-xs text-text-muted">Claude Code</div>
            <CopyBlock text={mcpCommand()} />
          </div>
        )}

        <details className="card p-4">
          <summary className="text-xs font-medium text-text-muted cursor-pointer">REST API</summary>
          <div className="mt-3">
            <CopyBlock text={`curl -X POST https://buildd.dev/api/workers/claim \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"maxTasks": 1}'`} />
          </div>
        </details>
      </div>
    </details>
  );
}
