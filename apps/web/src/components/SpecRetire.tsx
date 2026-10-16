'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import Notice from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import type { RetirementView } from '@/lib/specs/retire';

const NONE = 'none';

/**
 * Retiring a spec (living-specs.md §22, R-54). A retired spec reads "Retired:
 * <reason>" or "Replaced by <spec>", with Restore for a person who may. A live
 * one offers that person Retire, folded away among the secondary actions:
 * a reason and an optional replacement. Both post to /api/specs/[id]/retire.
 */
export default function SpecRetire({ specId, retirement, canRetire, targets = [] }: {
  specId: string;
  retirement: RetirementView | null;
  canRetire: boolean;
  targets?: ReadonlyArray<{ id: string; title: string }>;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [by, setBy] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/retire`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    const json = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (res?.ok) router.refresh();
    else setError(json?.error ?? 'That did not work. Try again.');
  }

  if (retirement) {
    return (
      <div className="flex flex-col gap-2" data-testid="spec-retired">
        <Notice tone="warn">
          {retirement.supersededBy ? (
            <span data-testid="spec-retired-line">
              Replaced by <Link href={`/app/specs/${retirement.supersededBy.id}`} className="underline">{retirement.supersededBy.title}</Link>. {retirement.reason}
            </span>
          ) : (
            <span data-testid="spec-retired-line">Retired: {retirement.reason}</span>
          )}
        </Notice>
        {error ? <Notice tone="err">{error}</Notice> : null}
        {canRetire ? (
          <button type="button" disabled={busy} onClick={() => send('DELETE', {})} className="self-start min-h-11 md:min-h-9 px-3 border border-border-strong text-body text-text-primary hover:bg-surface-3 disabled:opacity-50" data-testid="spec-restore">
            Restore
          </button>
        ) : null}
      </div>
    );
  }
  if (!canRetire) return null;

  const options = [{ value: NONE, label: 'Nothing replaces it' }, ...targets.map((t) => ({ value: t.id, label: t.title }))];
  const ok = reason.trim().length >= 10;
  return (
    <div className="mt-4" data-testid="spec-retire">
    <Disclosure summary="Retire this spec">
      <div className="flex flex-col gap-2 pt-2" data-testid="spec-retire-form">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Why it is retired"
          aria-label="Why it is retired"
          className="w-full px-2.5 py-1.5 bg-surface-1 border border-border-default text-body text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          data-testid="spec-retire-reason"
        />
        <Select aria-label="Replaced by" value={by} onChange={setBy} options={options} testId="spec-retire-by" />
        {error ? <Notice tone="err">{error}</Notice> : null}
        <button
          type="button"
          disabled={busy || !ok}
          onClick={() => send('POST', { reason: reason.trim(), ...(by !== NONE ? { supersededBy: by } : {}) })}
          className="self-start min-h-11 md:min-h-9 px-3 border border-border-strong text-body text-text-primary hover:bg-surface-3 disabled:opacity-50"
          data-testid="spec-retire-submit"
        >
          {by !== NONE ? 'Mark replaced' : 'Retire'}
        </button>
      </div>
    </Disclosure>
    </div>
  );
}
