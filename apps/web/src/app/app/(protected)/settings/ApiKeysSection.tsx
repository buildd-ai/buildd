import Link from 'next/link';
import DeleteAccountButton from '../accounts/DeleteAccountButton';
import CopyBlock from '@/components/CopyBlock';

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

      <McpSetupSection apiKey={accounts.find(a => a.apiKeyPrefix)?.apiKeyPrefix ?? null} />
    </section>
  );
}

// ── MCP Setup Section ────────────────────────────────────────────────────────

function McpSetupSection({ apiKey }: { apiKey: string | null }) {
  const key = apiKey ? `${apiKey}...` : 'YOUR_API_KEY';

  return (
    <div className="mt-4 space-y-3">
      <h3 className="font-medium text-sm">Connect to buildd</h3>

      <div className="p-4 bg-surface-2 rounded-lg space-y-3">
        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">Claude Code</div>
        <CopyBlock text={`claude mcp add --transport http buildd https://buildd.dev/api/mcp -- --header "Authorization: Bearer ${key}"`} />
      </div>

      <details className="p-4 bg-surface-2 rounded-lg">
        <summary className="text-xs font-medium text-text-secondary uppercase tracking-wide cursor-pointer">REST API</summary>
        <div className="mt-3">
          <CopyBlock text={`curl -X POST https://buildd.dev/api/workers/claim \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"maxTasks": 1}'`} />
        </div>
      </details>
    </div>
  );
}
