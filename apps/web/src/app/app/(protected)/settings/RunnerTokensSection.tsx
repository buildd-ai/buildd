'use client';

import { useState } from 'react';
import { TOKEN_SCOPE_DEFINITIONS } from '@buildd/core/token-scopes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import DeleteAccountButton from './DeleteAccountButton';
import ConfirmDialog from '@/components/ConfirmDialog';
import ApiKeyModal from '@/components/ApiKeyModal';
import SettingsSection from './SettingsSection';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { StatusChip } from './_components/ConnectionRow';
import { unlinkedTokensChip } from './_lib/unlinked-tokens';
import { accountReachesWorkspace } from '@/lib/workspace-reach';
import { groupRunnerTokens } from './_lib/runner-token-groups';
import { shortAgo } from '@/lib/mission-list-card';
import HostRunnerToggle from './HostRunnerToggle';
import MaxConcurrentWorkersEditor from './MaxConcurrentWorkersEditor';

interface Account {
  id: string;
  name: string;
  type: string;
  authType: string;
  apiKeyPrefix: string | null;
  level?: string;
  scopes?: string[] | null;
  workspaceIds?: string[] | null;
  lastUsedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  maxConcurrentWorkers: number;
  totalCost: string | null;
  activeSessions: number | null;
  maxConcurrentSessions: number | null;
  budgetExhaustedAt: string | Date | null;
  budgetResetsAt: string | Date | null;
  team: { name: string } | null;
  teamId?: string;
  accountWorkspaces?: { workspaceId: string }[];
  createdAt?: string | Date | null;
  /** Latest runner heartbeat on this token, ISO; absent when not seen recently. */
  lastSeenAt?: string | null;
  /** Trusted as a long-lived host runner (team credential access). */
  hostRunner?: boolean;
  /**
   * The viewer holds manage_team_keys in this token's team, so may change
   * hostRunner and the worker limit, and regenerate or delete the token.
   */
  canManageHostRunner?: boolean;
  /**
   * The viewer may delete this token: they hold manage_team_keys, or they made
   * it (DELETE /api/accounts/[id]). Omitted = canManageHostRunner.
   */
  canDelete?: boolean;
}

/** "seen 4m ago", "seen now", or nothing when no runner has reported lately. */
function seenLabel(iso: string | null | undefined): string | null {
  const ago = shortAgo(iso ?? null);
  if (!ago) return null;
  return ago === 'now' ? 'seen now' : `seen ${ago} ago`;
}

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
  teamId?: string;
  accessMode?: string | null;
}

/** Where a new runner token is made: a sheet over Runners. */
export const NEW_TOKEN_HREF = '/app/settings/runners?new=1';

export default function RunnerTokensSection({ accounts, workspaces = [] }: { accounts: Account[]; workspaces?: Workspace[] }) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Teams start folded: the header row already says how many tokens and when one was last seen.
  const [openTeams, setOpenTeams] = useState<Set<string>>(() => new Set());
  const [maxConcurrentWorkers, setMaxConcurrentWorkers] = useState<Record<string, number>>(
    accounts.reduce((acc, a) => ({ ...acc, [a.id]: a.maxConcurrentWorkers }), {}),
  );
  const groups = groupRunnerTokens(accounts);
  const toggleTeam = (team: string) => setOpenTeams((cur) => {
    const next = new Set(cur);
    if (next.has(team)) next.delete(team); else next.add(team);
    return next;
  });
  const [regenerateTarget, setRegenerateTarget] = useState<Account | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ accountName: string; apiKey: string } | null>(null);

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
        throw new Error(err.error || 'Could not regenerate the token.');
      }

      const data = await res.json();
      setRegenerateTarget(null);
      setNewKey({ accountName: regenerateTarget.name, apiKey: data.apiKey });
      router.refresh();
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : 'Could not regenerate the token.');
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <SettingsSection
      title="Runner tokens"
      bare
      id="runner-tokens"
      // One primary: with tokens the header link is a plain button; empty, the
      // inline "Create a runner token" below is the primary and this is hidden.
      action={accounts.length > 0 ? <Link href={NEW_TOKEN_HREF} scroll={false} className="btn" data-testid="new-token">+ New token</Link> : undefined}
    >
      <p className="text-xs text-text-secondary mb-3">
        For runners, CI and analytics clients. Model sign-ins are on Models.
      </p>

      {accounts.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="runner-tokens-empty">
          <p className="text-sm text-text-muted">No runner tokens.</p>
          <PrimaryAction href={NEW_TOKEN_HREF}>Create a runner token</PrimaryAction>
        </div>
      ) : (
        <div className="card divide-y divide-border-default p-0">
          {groups.map((group) => {
            const teamOpen = openTeams.has(group.team);
            const seen = seenLabel(group.lastSeenAt);
            const unlinked = group.tokens.filter((a) => a.accountWorkspaces && a.accountWorkspaces.length === 0).length;
            // A token with no link still reaches its own team's open workspaces.
            const groupTeamId = group.tokens[0]?.teamId;
            const openWorkspaces = groupTeamId
              ? workspaces.filter((w) => w.teamId && accountReachesWorkspace({ teamId: groupTeamId }, { teamId: w.teamId, accessMode: w.accessMode }, null)).length
              : 0;
            const chip = unlinkedTokensChip(unlinked, openWorkspaces);
            return (
              <div key={group.team} data-testid="token-group" data-open={teamOpen ? 'true' : 'false'}>
                <button
                  onClick={() => toggleTeam(group.team)}
                  aria-expanded={teamOpen}
                  className="w-full flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-surface-3 transition-colors text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="text-sm font-semibold text-text-primary truncate">{group.team}</span>
                      {chip && <StatusChip tone={chip.tone}>{chip.label}</StatusChip>}
                    </span>
                    <span className="mt-1 block truncate text-meta text-text-muted">
                      <span className="font-mono">{group.tokens.length}</span> token{group.tokens.length === 1 ? '' : 's'}{seen ? ` · ${seen}` : ''}
                    </span>
                  </span>
                  <span aria-hidden="true" className={`shrink-0 font-mono text-[12px] text-text-muted transition-transform ${teamOpen ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {teamOpen && (
                  <div className="divide-y divide-border-default border-t border-border-default">
                    {group.tokens.map((account) => {
                      const isExpanded = expandedId === account.id;
                      // Warn only when the token reaches nothing: no link and no open workspace.
                      const hasWarning = account.accountWorkspaces && account.accountWorkspaces.length === 0 && chip?.tone === 'warn';
                      const canAdmin = account.canManageHostRunner === true;
                      const canDelete = (account.canDelete ?? canAdmin) === true;

                      return (
                        <div key={account.id}>
                          {/* Compact row */}
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : account.id)}
                            aria-expanded={isExpanded}
                            className="w-full flex min-h-12 items-center gap-3 py-2.5 pl-6 pr-4 hover:bg-surface-3 transition-colors text-left"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-text-primary truncate">{account.name}</span>
                                {hasWarning && (
                                  <span className="w-2 h-2 bg-status-warning flex-shrink-0" title="No workspace linked" />
                                )}
                              </div>
                              {account.expiresAt && (
                                <div className={`mt-0.5 text-meta ${new Date(account.expiresAt).getTime() <= Date.now() ? 'text-status-warning' : 'text-text-muted'}`}>
                                  {new Date(account.expiresAt).getTime() <= Date.now() ? 'Expired' : 'Expires'} {new Date(account.expiresAt).toLocaleDateString()}
                                </div>
                              )}
                              {seenLabel(account.lastSeenAt) && (
                                <div data-testid="token-last-seen" className="mt-0.5 text-meta text-text-muted">{seenLabel(account.lastSeenAt)}</div>
                              )}
                            </div>
                            <code className="text-xs text-text-muted font-mono flex-shrink-0">
                              {account.apiKeyPrefix ? `${account.apiKeyPrefix}...` : 'no API key'}
                            </code>
                            <svg className={`w-4 h-4 text-text-muted transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>

                          {/* Expanded detail */}
                          {isExpanded && (
                            <div className="pl-6 pr-4 pb-3 space-y-3">
                              <div className="inset-panel space-y-2">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                                  <span>Auth: {account.authType}</span>
                                  <span>·</span>
                                  <span>Type: {account.type}</span>
                                  <span>·</span>
                                  <MaxConcurrentWorkersEditor
                                    accountId={account.id}
                                    value={maxConcurrentWorkers[account.id] ?? account.maxConcurrentWorkers}
                                    onUpdate={(newValue) => setMaxConcurrentWorkers((cur) => ({ ...cur, [account.id]: newValue }))}
                                    canEdit={canAdmin}
                                  />
                                  {account.authType === 'api' && (
                                    <><span>·</span><span>Cost: ${account.totalCost}</span></>
                                  )}
                                  {account.authType === 'oauth' && (
                                    <><span>·</span><span>Sessions: {account.activeSessions}/{account.maxConcurrentSessions || '∞'}</span></>
                                  )}
                                  {account.budgetExhaustedAt && (
                                    <><span>·</span><span className="text-status-error">Budget exhausted{account.budgetResetsAt && ` · Resets ${new Date(account.budgetResetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span></>
                                  )}
                                </div>

                                <div className="text-xs space-y-2">
                                  <p className="section-label">Capabilities</p>
                                  {account.scopes == null ? <p className="text-text-secondary">Legacy {account.level || 'worker'} permissions</p> : account.scopes.length === 0 ? <p className="text-text-muted">No capabilities</p> : <ul className="space-y-1">{account.scopes.map(scope => <li key={scope}>{TOKEN_SCOPE_DEFINITIONS.find(def => def.scope === scope)?.label || scope} <code className="text-text-muted">{scope}</code></li>)}</ul>}
                                  <p className="text-text-secondary">{account.workspaceIds == null ? 'All linked workspaces' : `Restricted to: ${account.workspaceIds.map(id => workspaces.find(ws => ws.id === id)?.name || 'Linked workspace').join(', ') || 'none'}`}</p>
                                  <p className="text-text-muted">{account.lastUsedAt ? `Last used: ${new Date(account.lastUsedAt).toLocaleString()}` : 'Never used'} · {account.expiresAt ? `Expires: ${new Date(account.expiresAt).toLocaleString()}` : 'No expiry'}</p>
                                </div>

                                {hasWarning && (
                                  <p className="text-xs text-status-warning">No workspace linked. This token can&apos;t claim or create tasks.</p>
                                )}

                                <HostRunnerToggle
                                  accountId={account.id}
                                  hostRunner={account.hostRunner === true}
                                  canManage={canAdmin}
                                />

                                {(canAdmin || canDelete) && (
                                  <div className="flex flex-wrap items-center gap-2">
                                    {canAdmin && (
                                      <button
                                        onClick={() => { setRegenerateError(null); setRegenerateTarget(account); }}
                                        className="btn"
                                      >
                                        Regenerate key
                                      </button>
                                    )}
                                    {canDelete && (
                                      <DeleteAccountButton accountId={account.id} accountName={account.name} />
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Regenerate confirmation dialog */}
      <ConfirmDialog
        open={!!regenerateTarget}
        title="Regenerate runner token?"
        message={regenerateError || `Invalidates the current token for "${regenerateTarget?.name}". Runners using the old token lose access immediately.`}
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
          onClose={() => setNewKey(null)}
        />
      )}
    </SettingsSection>
  );
}
