'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';

interface Team {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export default function NewAccountPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdAccount, setCreatedAccount] = useState<{ name: string; apiKey: string } | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [accountType, setAccountType] = useState('user');
  const [authType, setAuthType] = useState('oauth');
  const [tokenLevel, setTokenLevel] = useState('worker');

  useEffect(() => {
    async function loadTeams() {
      try {
        const res = await fetch('/api/teams');
        if (res.ok) {
          const data = await res.json();
          setTeams(data.teams || []);
          // Default to personal team
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
      maxConcurrentWorkers: parseInt(formData.get('maxConcurrentWorkers') as string) || 3,
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

  if (createdAccount) {
    return (
      <main className="min-h-screen p-8">
        <div className="max-w-xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">Account Created</h1>

          <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-4 mb-6">
            <p className="text-status-success font-medium">
              Save this API key - it won't be shown again!
            </p>
          </div>

          <div className="border border-border-default rounded-lg p-4 mb-6">
            <div className="text-sm text-text-secondary mb-1">Account</div>
            <div className="font-medium mb-4">{createdAccount.name}</div>

            <div className="text-sm text-text-secondary mb-1">API Key</div>
            <div className="bg-surface-3 rounded p-3 font-mono text-sm break-all">
              <code>{createdAccount.apiKey}</code>
            </div>
          </div>

          <div className="bg-surface-2 rounded-lg p-4 mb-6">
            <h3 className="font-medium mb-2">Environment Variable</h3>
            <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto">
              BUILDD_API_KEY={createdAccount.apiKey}
            </pre>
          </div>

          <Link
            href="/app/settings"
            className="block text-center px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
          >
            Back to Settings
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/app/settings" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
          &larr; Settings
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Account</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-status-error/10 border border-status-error/30 rounded-lg text-status-error">
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
                { value: 'oauth', label: 'OAuth - Uses CLAUDE_CODE_OAUTH_TOKEN (seat-based)' },
                { value: 'api', label: 'API - Uses ANTHROPIC_API_KEY (pay-per-token)' },
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
              defaultValue="3"
              className="w-full px-4 py-2 border border-border-default rounded-md bg-surface-1"
            />
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Account'}
            </button>
            <Link
              href="/app/settings"
              className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
