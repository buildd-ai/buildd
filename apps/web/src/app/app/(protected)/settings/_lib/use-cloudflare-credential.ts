'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CloudflareCredentialView } from './cloudflare-state';

/** Fired after any load, so every reader on the page shows the same state. */
const EVENT = 'buildd:cloudflare-credential';

interface Detail { teamId: string; cred: CloudflareCredentialView | null }

/**
 * The team's Cloudflare credential (masked) from the existing
 * `GET /api/cloudflare/credential`. The fleet's cloud-runner row and the
 * Cloudflare section both read it; a store, verify or delete in the section
 * reloads, and the reload is broadcast so the fleet row follows.
 */
export function useCloudflareCredential(teamId: string) {
  const [cred, setCred] = useState<CloudflareCredentialView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/cloudflare/credential?teamId=${teamId}`);
      if (res.ok) {
        const data = await res.json();
        const next = (data.credential ?? null) as CloudflareCredentialView | null;
        setCred(next);
        setError(null);
        window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { teamId, cred: next } }));
      }
    } catch {
      setError('Failed to load the Cloudflare token');
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [teamId]);

  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [reload]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Detail>).detail;
      if (d?.teamId === teamId) { setCred(d.cred); setLoaded(true); }
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [teamId]);

  return { cred, loading, loaded, error, reload };
}
