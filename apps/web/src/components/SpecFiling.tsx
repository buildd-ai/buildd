'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Notice from '@/components/ui/Notice';
import type { FilingView } from '@/lib/specs/filings';

/**
 * Where buildd placed this spec (living-specs.md §17, R-7): "Filed by buildd"
 * with an undo, or the place it suggests with accept and dismiss. Each posts
 * to /api/specs/[id]/filing; nothing here moves the spec's version.
 */
export default function SpecFiling({ specId, filing, canAct }: { specId: string; filing: FilingView; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'undo' | 'accept' | 'dismiss') => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, filingId: filing.id }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (res?.ok) router.refresh();
    else setError(body?.error ?? 'That did not work. Try again.');
  };
  const area = filing.parent;
  const link = area ? <Link href={`/app/specs/${area.specId}`} className="underline hover:text-text-primary">{area.title}</Link> : null;

  return (
    <div className="flex flex-col gap-2" data-testid="spec-page-filing" data-kind={filing.kind}>
      {filing.kind === 'filed' ? (
        <p className="text-body text-text-secondary">
          Filed by buildd under {link ?? 'an area'}{filing.previousParent ? `, moved from ${filing.previousParent.title}` : ''}.
        </p>
      ) : filing.newArea ? (
        <p className="text-body text-text-secondary">buildd found no area for this spec. It may need a new one, such as "{filing.newArea.title}".</p>
      ) : (
        <p className="text-body text-text-secondary">buildd suggests filing this under {link ?? 'an area'}.</p>
      )}
      {error ? <Notice tone="err">{error}</Notice> : null}
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          {filing.kind === 'filed' ? (
            <button type="button" className="btn btn-sm h-11 md:h-8" disabled={busy} onClick={() => act('undo')} data-testid="spec-page-filing-undo">Undo</button>
          ) : (
            <>
              {area ? <button type="button" className="btn btn-sm h-11 md:h-8" disabled={busy} onClick={() => act('accept')} data-testid="spec-page-filing-accept">File it there</button> : null}
              <button type="button" className="btn btn-sm h-11 md:h-8" disabled={busy} onClick={() => act('dismiss')} data-testid="spec-page-filing-dismiss">Dismiss</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
