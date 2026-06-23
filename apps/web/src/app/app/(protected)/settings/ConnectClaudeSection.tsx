'use client';

import { useMemo, useState } from 'react';
import CopyBlock from '@/components/CopyBlock';

interface Workspace {
  id: string;
  name: string;
  repo: string | null;
}

/**
 * Connect-Claude card. Renders the workspace-scoped MCP URLs and copy-paste
 * snippets for claude.ai (OAuth flow) and Claude Code CLI (API key).
 *
 * One connector = one workspace. The dropdown swaps the URL; the user adds
 * a separate connector per workspace they want exposed.
 */
export default function ConnectClaudeSection({ workspaces }: { workspaces: Workspace[] }) {
  const [workspaceId, setWorkspaceId] = useState<string>(workspaces[0]?.id ?? '');
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://buildd-three.vercel.app';

  const oauthUrl = useMemo(
    () => (workspaceId ? `${origin}/api/mcp-oauth/${workspaceId}` : ''),
    [origin, workspaceId],
  );

  const apiKeyUrl = `${origin}/api/mcp`;
  const wsLabel = useMemo(() => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    return ws ? (ws.repo || ws.name) : '';
  }, [workspaceId, workspaces]);

  const cliCommand = useMemo(() => {
    if (!workspaceId) return '';
    return `claude mcp add buildd --transport http "${apiKeyUrl}?workspace=${workspaceId}" \\
  --header "Authorization: Bearer $BUILDD_API_KEY"`;
  }, [apiKeyUrl, workspaceId]);

  if (workspaces.length === 0) {
    return (
      <section>
        <h2 className="section-label mb-3">Connect Claude</h2>
        <div className="card p-4">
          <p className="text-sm text-text-muted">
            Create a workspace first to expose it as an MCP connector.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-end justify-between mb-3 gap-3">
        <h2 className="section-label">Connect Claude</h2>
        {workspaces.length > 1 && (
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="bg-surface-3 border border-surface-4 rounded px-2 py-1 text-sm text-text-primary"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}{ws.repo ? ` (${ws.repo})` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="card p-4 space-y-6">
        {/* claude.ai (OAuth) */}
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">claude.ai (web &amp; mobile)</h3>
          <p className="text-xs text-text-secondary mb-2 leading-relaxed">
            In claude.ai: <strong>Settings → Connectors → Add custom connector</strong>. Paste the URL
            below. You&apos;ll be redirected to buildd to sign in (or confirm) — the connector binds to
            <strong className="text-text-primary"> {wsLabel}</strong> only. To expose another workspace,
            switch above and add it as a separate connector.
          </p>
          <CopyBlock text={oauthUrl} />
        </div>

        {/* Claude Code (CLI) */}
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">Claude Code (CLI)</h3>
          <p className="text-xs text-text-secondary mb-2 leading-relaxed">
            For local terminal use, point Claude Code at the API-key endpoint. Set{' '}
            <code className="bg-surface-3 px-1 rounded text-[11px]">$BUILDD_API_KEY</code> in your shell
            first — generate one above in <strong>API Keys</strong> if you don&apos;t have it.
          </p>
          <CopyBlock text={cliCommand} />
        </div>

        {/* Details */}
        <div className="pt-2 border-t border-surface-4">
          <dl className="grid grid-cols-[auto_1fr] sm:grid-cols-[120px_1fr] gap-y-1 gap-x-3 text-xs text-text-secondary">
            <dt>Transport</dt>
            <dd className="font-mono text-text-primary">streamable HTTP</dd>
            <dt>Workspace</dt>
            <dd className="font-mono text-text-primary break-all">{workspaceId}</dd>
            <dt>OAuth scope</dt>
            <dd className="font-mono text-text-primary">mcp</dd>
            <dt>CLI auth</dt>
            <dd className="font-mono text-text-primary">Authorization: Bearer &lt;api-key&gt;</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}
