import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import DeleteAccountButton from './DeleteAccountButton';
import { getCurrentUser } from '@/lib/auth-helpers';

export default async function AccountsPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let allAccounts: typeof accounts.$inferSelect[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/auth/signin');
    }

    try {
      allAccounts = await db.query.accounts.findMany({
        where: eq(accounts.ownerId, user.id),
        orderBy: desc(accounts.createdAt),
      });
    } catch (error) {
      console.error('Accounts query error:', error);
    }
  }

  const typeColors: Record<string, string> = {
    user: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    service: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    action: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 mb-2 block">
              ← Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Accounts</h1>
            <p className="text-gray-500">API keys for agents to connect</p>
          </div>
          <Link
            href="/accounts/new"
            className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
          >
            + New Account
          </Link>
        </div>

        {allAccounts.length === 0 ? (
          <div className="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No accounts yet</h2>
            <p className="text-gray-500 mb-6">
              Create an account to get an API key for agents
            </p>
            <Link
              href="/accounts/new"
              className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-80"
            >
              Create Account
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {allAccounts.map((account) => (
              <div
                key={account.id}
                className="border border-gray-200 dark:border-gray-800 rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="font-medium">{account.name}</h3>
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full mt-1 ${typeColors[account.type]}`}>
                      {account.type}
                    </span>
                  </div>
                  <div className="text-right text-sm text-gray-500">
                    <div>Workers: {account.maxConcurrentWorkers}</div>
                    <div>Tasks: {account.totalTasks}</div>
                  </div>
                </div>

                <div className="bg-gray-100 dark:bg-gray-800 rounded p-3 font-mono text-sm break-all">
                  <div className="text-xs text-gray-500 mb-1">API Key</div>
                  <code>{account.apiKey}</code>
                </div>

                <div className="mt-3 flex justify-between items-center">
                  <span className="text-xs text-gray-500">
                    Auth: {account.authType} |
                    {account.authType === 'api' && ` Cost: $${account.totalCost}`}
                    {account.authType === 'oauth' && ` Sessions: ${account.activeSessions}/${account.maxConcurrentSessions || '∞'}`}
                  </span>
                  <DeleteAccountButton accountId={account.id} accountName={account.name} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 space-y-6">
          {/* MCP Setup */}
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h3 className="font-medium mb-2">Claude Code MCP Setup</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              Connect Claude Code directly to buildd with one command:
            </p>
            <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add-json buildd '{"type":"stdio","command":"bun","args":["run","~/path/to/buildd/apps/mcp-server/src/index.ts"],"env":{"BUILDD_API_KEY":"YOUR_API_KEY","BUILDD_SERVER":"https://buildd-three.vercel.app"}}'`}
            </pre>
            <p className="text-xs text-gray-500 mt-2">
              Or add <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">--scope user</code> to use across all projects
            </p>
          </div>

          {/* Alternative: Manual .mcp.json */}
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h3 className="font-medium mb-2">Alternative: .mcp.json</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              Add to your project's <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">.mcp.json</code>:
            </p>
            <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "~/path/to/buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_SERVER": "https://buildd-three.vercel.app",
        "BUILDD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}`}
            </pre>
          </div>

          {/* REST API */}
          <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <h3 className="font-medium mb-2">REST API</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              Or use the API directly to claim tasks:
            </p>
            <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`curl -X POST https://buildd-three.vercel.app/api/workers/claim \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"maxTasks": 1}'`}
            </pre>
          </div>
        </div>
      </div>
    </main>
  );
}
