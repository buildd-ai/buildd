'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import ApiKeyModal from '@/components/ApiKeyModal';

interface Team {
  id: string;
  name: string;
  slug: string;
  role: string;
}

const DEFAULTS = {
  type: 'user',
  authType: 'api',
  level: 'worker',
  maxConcurrentWorkers: 5,
};

export default function NewAccountPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdAccount, setCreatedAccount] = useState<{ name: string; apiKey: string } | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [accountType, setAccountType] = useState(DEFAULTS.type);
  const [authType, setAuthType] = useState(DEFAULTS.authType);
  const [tokenLevel, setTokenLevel] = useState(DEFAULTS.level);
  const [maxConcurrent, setMaxConcurrent] = useState(DEFAULTS.maxConcurrentWorkers.toString());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const hasNonDefaults =
    accountType !== DEFAULTS.type ||
    authType !== DEFAULTS.authType ||
    tokenLevel !== DEFAULTS.level ||
    parseInt(maxConcurrent) !== DEFAULTS.maxConcurrentWorkers;

  useEffect(() => {
    async function loadTeams() {
      try {
        const res = await fetch('/api/teams');
        if (res.ok) {
          const data = await res.json();
          setTeams(data.teams || []);
          const personal = (data.teams || []).find((t: Team) => t.slug.startsWith('personal-'));
          if (personal) {
            setSelectedTeamId(personal.id);
          } else if (data.teams?.length > 0) {
            setSelectedTeamId(data.teams[0].id);
          }
        }
      } catch {
        // Teams not available
      }
    }
    loadTeams();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const data: Record<string, unknown> = {
      name: formData.get('name') as string,
      type: accountType,
      authType,
      level: tokenLevel,
      maxConcurrentWorkers: parseInt(maxConcurrent) || DEFAULTS.maxConcurrentWorkers,
    };
    if (selectedTeamId) {
      data.teamId = selectedTeamId;
    }

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create account');
      }

      const account = await res.json();
      setCreatedAccount({ name: account.name, apiKey: account.apiKey });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/app/settings" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
          &larr; Settings
        </Link>
        <h1 className="text-2xl font-semibold mb-8">New Account</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error text-sm">
              {error}
            </div>
          )}

          {teams.length > 1 && (
            <div>
              <label htmlFor="team" className="block text-sm font-medium mb-2">
                Team
              </label>
              <Select
                id="team"
                value={selectedTeamId}
                onChange={setSelectedTeamId}
                options={teams.map((team) => ({
                  value: team.id,
                  label: team.name + (team.slug.startsWith('personal-') ? ' (Personal)' : ''),
                }))}
              />
              <p className="text-xs text-text-secondary mt-1">
                Which team owns this account
              </p>
            </div>
          )}

          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-2">
              Account Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              placeholder="my-laptop-agent"
              className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1"
            />
          </div>

          {/* Advanced Options */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform duration-150 ${showAdvanced ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              Advanced Options
              {hasNonDefaults && (
                <span className="w-2 h-2 rounded-full bg-status-info" />
              )}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-5 pl-5 border-l-2 border-border-default">
                <div>
                  <label htmlFor="type" className="block text-sm font-medium mb-2">
                    Account Type
                  </label>
                  <Select
                    id="type"
                    value={accountType}
                    onChange={setAccountType}
                    options={[
                      { value: 'user', label: 'User - Personal laptop/workstation' },
                      { value: 'service', label: 'Service - Always-on server/VM' },
                      { value: 'action', label: 'Action - GitHub Actions runner' },
                    ]}
                  />
                  <p className="text-xs text-text-secondary mt-1">
                    Affects task routing with runnerPreference
                  </p>
                </div>

                <div>
                  <label htmlFor="authType" className="block text-sm font-medium mb-2">
                    Auth Type
                  </label>
                  <Select
                    id="authType"
                    value={authType}
                    onChange={setAuthType}
                    options={[
                      { value: 'api', label: 'API - Uses ANTHROPIC_API_KEY (pay-per-token)' },
                      { value: 'oauth', label: 'OAuth - Uses CLAUDE_CODE_OAUTH_TOKEN (seat-based)' },
                    ]}
                  />
                </div>

                <div>
                  <label htmlFor="level" className="block text-sm font-medium mb-2">
                    Token Level
                  </label>
                  <Select
                    id="level"
                    value={tokenLevel}
                    onChange={setTokenLevel}
                    options={[
                      { value: 'worker', label: 'Worker - Can claim and execute tasks' },
                      { value: 'admin', label: 'Admin - Can also reassign and manage tasks' },
                    ]}
                  />
                  <p className="text-xs text-text-secondary mt-1">
                    Admin tokens can reassign stuck tasks via MCP
                  </p>
                </div>

                <div>
                  <label htmlFor="maxConcurrentWorkers" className="block text-sm font-medium mb-2">
                    Max Concurrent Workers
                  </label>
                  <input
                    type="number"
                    id="maxConcurrentWorkers"
                    name="maxConcurrentWorkers"
                    min="1"
                    max="10"
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(e.target.value)}
                    className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create API Key'}
            </button>
            <Link
              href="/app/settings"
              className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3 text-center"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>

      {/* API Key modal */}
      {createdAccount && (
        <ApiKeyModal
          open={!!createdAccount}
          accountName={createdAccount.name}
          apiKey={createdAccount.apiKey}
          onClose={() => {
            setCreatedAccount(null);
            router.push('/app/settings');
          }}
        />
      )}
    </main>
  );
}
