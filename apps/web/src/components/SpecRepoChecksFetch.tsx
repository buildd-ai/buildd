'use client';

import { useEffect, useState } from 'react';
import Spinner from '@/components/Spinner';
import SpecRepoChecks from '@/components/SpecRepoChecks';
import type { RepoCopyPreflight } from '@/lib/specs/repo-copy';

/**
 * The repo checks on the would-be copy (R-34), fetched after the page shows:
 * they ask GitHub, which is never on the path of opening a spec page (R-9) or
 * the approval confirm page (spec 3ef37387 R-14).
 */
export default function SpecRepoChecksFetch({ specId }: { specId: string }) {
  const [got, setGot] = useState<{ preflight: RepoCopyPreflight | null } | 'loading' | 'unread'>('loading');
  useEffect(() => {
    let live = true;
    fetch(`/api/specs/${encodeURIComponent(specId)}/preflight`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((b: { preflight?: RepoCopyPreflight | null }) => { if (live) setGot({ preflight: b.preflight ?? null }); })
      .catch(() => { if (live) setGot('unread'); });
    return () => { live = false; };
  }, [specId]);
  if (got === 'loading') {
    return (
      <p className="flex items-center gap-2 text-meta text-text-muted" data-testid="spec-repo-checks-loading">
        <Spinner size="xs" aria-label="Running the repo checks" /> Running the repo checks…
      </p>
    );
  }
  if (got === 'unread') return <p className="text-meta text-text-muted" data-testid="spec-repo-checks-unread">Couldn&apos;t run the repo checks. You can still approve; the PR runs them.</p>;
  return <SpecRepoChecks preflight={got.preflight} />;
}
