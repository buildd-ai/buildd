'use client';

import { useCallback, useEffect, useState } from 'react';
import { ProviderKeyCard, type KeyCardInfo } from '@/components/settings/ProviderKeyCard';
import type { ProviderKeyStatus } from '@/lib/provider-keys-client';
import { checkPushoverKeyShape, pushoverKeyStatus, type PersonalPushoverWire } from '@/lib/pushover-key-shape';

const INFO: KeyCardInfo = {
  id: 'pushover',
  label: 'Pushover',
  placeholder: 'u… (30 letters and digits)',
  consoleUrl: 'https://pushover.net',
};

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`;
}

/**
 * Settings, Notifications: your own Pushover key. Alerts for things you watch
 * go here when you are away (api/me/pushover). Same card as Model providers:
 * set, test, replace, remove; the key never comes back beyond last4.
 */
export default function PersonalPushoverKey({ teamId }: { teamId: string }) {
  const [status, setStatus] = useState<ProviderKeyStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qs = `teamId=${encodeURIComponent(teamId)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/me/pushover?${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const body = await res.json() as { key?: PersonalPushoverWire | null };
      setStatus(pushoverKeyStatus(body.key));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your Pushover key');
    } finally {
      setLoaded(true);
    }
  }, [qs]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section aria-labelledby="personal-pushover-h" data-testid="personal-pushover">
      <h2 id="personal-pushover-h" className="section-label mb-3">Your Pushover key</h2>
      {error && <div className="notice notice-err mb-3 text-xs">{error}</div>}
      <ProviderKeyCard
        info={INFO}
        status={status}
        mode="personal"
        canEdit
        loading={!loaded}
        keyNoun="user key"
        addLabel="Add your key"
        checkShape={checkPushoverKeyShape}
        hint={<>Your user key is on your <a href={INFO.consoleUrl} target="_blank" rel="noreferrer" className="underline hover:text-text-primary">Pushover dashboard</a>.</>}
        removeNote="Phone alerts stop. They still show in chat."
        onSave={async (value) => {
          const res = await fetch('/api/me/pushover', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, value }),
          });
          if (!res.ok) throw new Error(await errorText(res));
          const body = await res.json() as { key?: PersonalPushoverWire };
          const next = pushoverKeyStatus(body.key);
          setStatus(next);
          return next;
        }}
        onRemove={async () => {
          const res = await fetch(`/api/me/pushover?${qs}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(await errorText(res));
          await load();
        }}
        onTest={async () => {
          const res = await fetch('/api/me/pushover/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId }),
          });
          if (!res.ok) throw new Error(await errorText(res));
          const r = await res.json() as { ok: boolean; error: string | null };
          await load();
          return r;
        }}
      />
    </section>
  );
}
