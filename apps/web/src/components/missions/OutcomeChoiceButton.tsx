'use client';

/**
 * `Make this the outcome` / `Clear` on a Records row (Mission checks 072de598
 * I-28 rule 1, Navigation R-25): a person's choice of a completed mission's
 * primary outcome. The page re-reads once it is stored.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface OutcomeChoice {
  primaryId: string | null;
  eligibleIds: ReadonlySet<string>;
  choose: (artifactId: string | null) => Promise<boolean>;
}

export default function OutcomeChoiceButton({ artifactId, title, choice }: { artifactId: string; title: string; choice: OutcomeChoice }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = choice.primaryId === artifactId;
  const act = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await choice.choose(current ? null : artifactId);
    setBusy(false);
    if (ok) router.refresh();
    else setFailed(true);
  };
  return (
    <button
      type="button"
      data-testid="outcome-choice"
      data-current={current ? 'true' : undefined}
      disabled={busy}
      onClick={act}
      aria-label={current ? `Clear ${title} as the outcome` : `Make ${title} the outcome`}
      className="inline-flex min-h-11 shrink-0 items-center px-1 font-mono text-meta text-text-secondary hover:text-text-primary disabled:opacity-60 md:min-h-0"
    >
      {failed ? 'Couldn’t save · Retry' : current ? 'Outcome · Clear' : 'Make this the outcome'}
    </button>
  );
}
