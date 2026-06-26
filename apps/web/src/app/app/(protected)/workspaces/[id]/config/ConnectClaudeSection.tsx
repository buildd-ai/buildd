'use client';

import { useMemo } from 'react';
import CopyBlock from '@/components/CopyBlock';

interface Props {
  workspaceId: string;
  workspaceName: string;
}

export default function ConnectClaudeSection({ workspaceId, workspaceName }: Props) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://buildd.dev';

  const oauthUrl = useMemo(
    () => `${origin}/api/mcp-oauth/${workspaceId}`,
    [origin, workspaceId],
  );

  const apiKeyUrl = `${origin}/api/mcp`;

  const cliCommand = useMemo(() => {
    return `claude mcp add buildd --transport http "${apiKeyUrl}?workspace=${workspaceId}" \\
  --header "Authorization: Bearer $BUILDD_API_KEY"`;
  }, [apiKeyUrl, workspaceId]);

  return (
    <section className="mt-10">
      <h2 className="section-label mb-3">Connect Claude</h2>
      <div className="card p-4 space-y-6">
        {/* claude.ai (OAuth) */}
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">claude.ai (web &amp; mobile)</h3>
          <p className="text-xs text-text-secondary mb-2 leading-relaxed">
            In claude.ai: <strong>Settings → Connectors → Add custom connector</strong>. Paste the URL
            below. You&apos;ll be redirected to buildd to sign in (or confirm) — the connector binds to{' '}
            <strong className="text-text-primary">{workspaceName}</strong> only.
          </p>
          <CopyBlock text={oauthUrl} />
        </div>

        {/* Claude Code (CLI) */}
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">Claude Code (CLI)</h3>
          <p className="text-xs text-text-secondary mb-2 leading-relaxed">
            For local terminal use, point Claude Code at the API-key endpoint. Set{' '}
            <code className="bg-surface-3 px-1 rounded text-[11px]">$BUILDD_API_KEY</code> in your shell
            first — generate one in{' '}
            <a href="/app/settings" className="text-primary hover:underline">Settings → Runner Tokens</a>.
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
            <dd className="font-mono text-text-primary">Authorization: Bearer &lt;runner-token&gt;</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}
