import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import DeleteAccountButton from './DeleteAccountButton';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

export default async function AccountsPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const user = await getCurrentUser();

  let allAccounts: (typeof accounts.$inferSelect & { team?: { name: string } | null })[] = [];

  if (!isDev) {
    if (!user) {
      redirect('/app/auth/signin');
    }

    try {
      const teamIds = await getUserTeamIds(user.id);
      const rawAccounts = teamIds.length > 0 ? await db.query.accounts.findMany({
        where: inArray(accounts.teamId, teamIds),
        orderBy: desc(accounts.createdAt),
        with: {
          team: { columns: { name: true } },
        },
      }) : [];
      allAccounts = rawAccounts;
    } catch (error) {
      console.error('Accounts query error:', error);
    }
  }

  const typeColors: Record<string, string> = {
    user: 'bg-status-info/10 text-status-info',
    service: 'bg-primary/10 text-primary',
    action: 'bg-status-warning/10 text-status-warning',
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary mb-2 block">
              ← Dashboard
            </Link>
            <h1 className="text-3xl font-bold">Accounts</h1>
            <p className="text-text-secondary">API keys for agents to connect</p>
          </div>
          <Link
            href="/app/accounts/new"
            className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover"
          >
            + New Account
          </Link>
        </div>

        {allAccounts.length === 0 ? (
          <div className="border border-dashed border-border-default rounded-lg p-12 text-center">
            <h2 className="text-xl font-semibold mb-2">No accounts yet</h2>
            <p className="text-text-secondary mb-6">
              Create an account to get an API key for agents
            </p>
            <Link
              href="/app/accounts/new"
              className="px-6 py-3 bg-primary text-white rounded-md hover:bg-primary-hover"
            >
              Create Account
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {allAccounts.map((account) => (
              <div
                key={account.id}
                className="border border-border-default rounded-lg p-4"
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{account.name}</h3>
                      {account.team?.name && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-surface-3 text-text-secondary">{account.team.name}</span>
                      )}
                    </div>
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full mt-1 ${typeColors[account.type]}`}>
                      {account.type}
                    </span>
                  </div>
                  <div className="text-right text-sm text-text-secondary">
                    <div>Workers: {account.maxConcurrentWorkers}</div>
                    <div>Tasks: {account.totalTasks}</div>
                  </div>
                </div>

                <div className="bg-surface-3 rounded p-3 font-mono text-sm break-all">
                  <div className="text-xs text-text-secondary mb-1">API Key</div>
                  <code>{account.apiKeyPrefix ? `${account.apiKeyPrefix}...` : '(hashed)'}</code>
                </div>

                <div className="mt-3 flex justify-between items-center">
                  <span className="text-xs text-text-secondary">
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
          <div className="p-4 bg-surface-2 rounded-lg">
            <h3 className="font-medium mb-2">Claude Code MCP Setup</h3>
            <p className="text-sm text-text-secondary mb-3">
              Connect Claude Code directly to buildd with one command:
            </p>
            <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add-json buildd '{"type":"stdio","command":"bun","args":["run","~/path/to/buildd/apps/mcp-server/src/index.ts"],"env":{"BUILDD_API_KEY":"YOUR_API_KEY","BUILDD_SERVER":"https://buildd.dev"}}'`}
            </pre>
            <p className="text-xs text-text-secondary mt-2">
              Or add <code className="bg-surface-4 px-1 rounded">--scope user</code> to use across all projects
            </p>
          </div>

          {/* Alternative: Manual .mcp.json */}
          <div className="p-4 bg-surface-2 rounded-lg">
            <h3 className="font-medium mb-2">Alternative: .mcp.json</h3>
            <p className="text-sm text-text-secondary mb-3">
              Add to your project's <code className="bg-surface-4 px-1 rounded">.mcp.json</code>:
            </p>
            <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "~/path/to/buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_SERVER": "https://buildd.dev",
        "BUILDD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}`}
            </pre>
          </div>

          {/* REST API */}
          <div className="p-4 bg-surface-2 rounded-lg">
            <h3 className="font-medium mb-2">REST API</h3>
            <p className="text-sm text-text-secondary mb-3">
              Or use the API directly to claim tasks:
            </p>
            <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`curl -X POST https://buildd.dev/api/workers/claim \\
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
