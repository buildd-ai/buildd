import Link from 'next/link';
import DeleteAccountButton from '../accounts/DeleteAccountButton';

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
  team: { name: string } | null;
}

const typeColors: Record<string, string> = {
  user: 'bg-status-info/10 text-status-info',
  service: 'bg-primary/10 text-primary',
  action: 'bg-status-warning/10 text-status-warning',
};

export default function ApiKeysSection({ accounts }: { accounts: Account[] }) {
  return (
    <section>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">API Keys</h2>
        <Link
          href="/app/accounts/new"
          className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover"
        >
          + New Account
        </Link>
      </div>

      {accounts.length === 0 ? (
        <div className="border border-dashed border-border-default rounded-lg p-6 text-center">
          <p className="text-text-secondary mb-3 text-sm">No accounts yet</p>
          <Link
            href="/app/accounts/new"
            className="text-sm text-primary hover:underline"
          >
            Create an account to get an API key
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="border border-border-default rounded-lg p-4"
            >
              <div className="flex justify-between items-start mb-2">
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

              <div className="bg-surface-3 rounded p-2 font-mono text-sm break-all">
                <code>{account.apiKeyPrefix ? `${account.apiKeyPrefix}...` : '(hashed)'}</code>
              </div>

              <div className="mt-2 flex justify-between items-center">
                <span className="text-xs text-text-secondary">
                  Auth: {account.authType} |
                  {account.authType === 'api' && ` Cost: $${account.totalCost}`}
                  {account.authType === 'oauth' && ` Sessions: ${account.activeSessions}/${account.maxConcurrentSessions || '\u221E'}`}
                </span>
                <DeleteAccountButton accountId={account.id} accountName={account.name} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <div className="p-4 bg-surface-2 rounded-lg">
          <h3 className="font-medium mb-2 text-sm">Claude Code MCP Setup</h3>
          <p className="text-xs text-text-secondary mb-2">
            Connect Claude Code directly to buildd with one command:
          </p>
          <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">
{`claude mcp add-json buildd '{"type":"stdio","command":"bun","args":["run","~/path/to/buildd/apps/mcp-server/src/index.ts"],"env":{"BUILDD_API_KEY":"YOUR_API_KEY","BUILDD_SERVER":"https://buildd.dev"}}'`}
          </pre>
        </div>

        <div className="p-4 bg-surface-2 rounded-lg">
          <h3 className="font-medium mb-2 text-sm">REST API</h3>
          <pre className="bg-surface-4 text-text-primary p-3 rounded text-xs overflow-x-auto">
{`curl -X POST https://buildd.dev/api/workers/claim \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"maxTasks": 1}'`}
          </pre>
        </div>
      </div>
    </section>
  );
}
