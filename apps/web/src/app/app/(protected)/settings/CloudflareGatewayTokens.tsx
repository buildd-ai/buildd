'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';

/**
 * Settings → Cloudflare → Gateway tokens. Tokens minted from the team's
 * Cloudflare credential that can only run models (AI Gateway Run, Workers AI
 * Read): the person's own, which decision calls made for them spend, and the
 * team's, which agent runs send to the gateway. Masked; revoked at Cloudflare
 * on remove. See @buildd/core/cloudflare-gateway-tokens.
 */

type Scope = 'personal' | 'team';
interface Masked { scope: Scope; tokenHint: string; expiresOn: string | null; expired: boolean }
interface Tokens { personal: Masked | null; team: Masked | null; canManageTeam: boolean }

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return typeof body.error === 'string' ? body.error : "That didn’t go through. Try again.";
}

const COPY: Record<Scope, { title: string; what: string }> = {
  personal: { title: 'Your token', what: 'Decision calls made for you spend it, so Cloudflare shows your usage on its own.' },
  team: { title: 'Agents token', what: 'Agents using the AI Gateway send it. Team decision calls spend it.' },
};

export default function CloudflareGatewayTokens({ teamId }: { teamId: string }) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [busy, setBusy] = useState<Scope | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cloudflare/gateway-tokens?teamId=${encodeURIComponent(teamId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      setTokens(await res.json() as Tokens);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not load');
    }
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  async function create(scope: Scope) {
    setBusy(scope); setMsg(null);
    try {
      const res = await fetch('/api/cloudflare/gateway-tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId, scope }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not create the token');
    } finally {
      setBusy(null);
    }
  }

  async function remove(scope: Scope) {
    if (!(await confirm({
      title: scope === 'personal' ? 'Revoke your token?' : 'Revoke the agents token?',
      message: 'Cloudflare stops accepting it right away. Calls fall back to the team credential.',
      confirmLabel: 'Revoke',
      variant: 'danger',
    }))) return;
    setBusy(scope); setMsg(null);
    try {
      const res = await fetch(`/api/cloudflare/gateway-tokens?teamId=${encodeURIComponent(teamId)}&scope=${scope}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorText(res));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not revoke the token');
    } finally {
      setBusy(null);
    }
  }

  const row = (scope: Scope, t: Masked | null, canManage: boolean) => (
    <div key={scope} className="flex flex-wrap items-start justify-between gap-2" data-testid={`gateway-token-${scope}`}>
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{COPY[scope].title}</p>
        <p className="text-xs text-text-muted">{COPY[scope].what}</p>
        <p className="text-xs font-mono text-text-secondary" data-testid={`gateway-token-${scope}-status`}>
          {t ? `${t.tokenHint} · ${t.expired ? 'expired' : t.expiresOn ? `expires ${new Date(t.expiresOn).toLocaleDateString()}` : 'no expiry'}` : 'none'}
        </p>
      </div>
      {canManage && (
        <div className="flex gap-2">
          <button className="btn" disabled={busy !== null} onClick={() => create(scope)}>
            {busy === scope ? 'Working…' : t ? 'Renew' : 'Create'}
          </button>
          {t && <button className="btn btn-quiet" disabled={busy !== null} onClick={() => remove(scope)}>Revoke</button>}
        </div>
      )}
    </div>
  );

  return (
    <div className="border-t border-border-default pt-4 space-y-3" data-testid="gateway-tokens">
      <div>
        <p className="text-sm font-medium text-text-primary">Gateway tokens</p>
        <p className="text-xs text-text-muted">
          Made with the team token, which needs Account API Tokens: Edit. They can only run models, expire after 90 days, and are revoked one at a time.
        </p>
      </div>
      {tokens === null && !msg && <p className="text-xs text-text-tertiary">Loading…</p>}
      {tokens && row('personal', tokens.personal, true)}
      {tokens && row('team', tokens.team, tokens.canManageTeam)}
      {msg && <p role="alert" className="text-xs text-status-error break-words">{msg}</p>}
      {confirmDialog}
    </div>
  );
}
