'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function NewAccountPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdAccount, setCreatedAccount] = useState<{ name: string; apiKey: string } | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const formData = new FormData(e.currentTarget);
    const data = {
      name: formData.get('name') as string,
      type: formData.get('type') as string,
      authType: formData.get('authType') as string,
      level: formData.get('level') as string,
      maxConcurrentWorkers: parseInt(formData.get('maxConcurrentWorkers') as string) || 3,
    };

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

          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-6">
            <p className="text-green-800 dark:text-green-200 font-medium">
              Save this API key - it won't be shown again!
            </p>
          </div>

          <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
            <div className="text-sm text-gray-500 mb-1">Account</div>
            <div className="font-medium mb-4">{createdAccount.name}</div>

            <div className="text-sm text-gray-500 mb-1">API Key</div>
            <div className="bg-gray-100 dark:bg-gray-800 rounded p-3 font-mono text-sm break-all">
              <code>{createdAccount.apiKey}</code>
            </div>
          </div>

          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 mb-6">
            <h3 className="font-medium mb-2">Environment Variable</h3>
            <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
              BUILDD_API_KEY={createdAccount.apiKey}
            </pre>
          </div>

          <Link
            href="/accounts"
            className="block text-center px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            View All Accounts
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-xl mx-auto">
        <Link href="/accounts" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
          ← Accounts
        </Link>
        <h1 className="text-3xl font-bold mb-8">New Account</h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
              {error}
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
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
            />
          </div>

          <div>
            <label htmlFor="type" className="block text-sm font-medium mb-2">
              Account Type
            </label>
            <select
              id="type"
              name="type"
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
            >
              <option value="user">User - Personal laptop/workstation</option>
              <option value="service">Service - Always-on server/VM</option>
              <option value="action">Action - GitHub Actions runner</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Affects task routing with runnerPreference
            </p>
          </div>

          <div>
            <label htmlFor="authType" className="block text-sm font-medium mb-2">
              Auth Type
            </label>
            <select
              id="authType"
              name="authType"
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
            >
              <option value="oauth">OAuth - Uses CLAUDE_CODE_OAUTH_TOKEN (seat-based)</option>
              <option value="api">API - Uses ANTHROPIC_API_KEY (pay-per-token)</option>
            </select>
          </div>

          <div>
            <label htmlFor="level" className="block text-sm font-medium mb-2">
              Token Level
            </label>
            <select
              id="level"
              name="level"
              required
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
            >
              <option value="worker">Worker - Can claim and execute tasks</option>
              <option value="admin">Admin - Can also reassign and manage tasks</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
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
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
            />
          </div>

          <div className="flex gap-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Account'}
            </button>
            <Link
              href="/accounts"
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
