'use client';

/**
 * The stranded local mission's call (lib/local-strand.ts): "Continue on a
 * runner" or "Keep local". One component for the Home row, the missions-list
 * card, the mission page and the chat mission object.
 *
 * - Continue on a runner: PATCH the mission's executor to `runner`. The route
 *   re-dispatches the open tasks to runners; nothing else is needed here.
 * - Keep local: nothing changes on the mission. The card says how to pick the
 *   work up from a session (`claim_task {taskId}`).
 *
 * Both taps are recorded as the label for the `mission_strand_choice` shadow
 * (fire-and-forget; a failed record never blocks the action).
 *
 * `strand.blockedReason` is the refusal the PATCH route would give
 * (`continueOnRunnerBlockedReason`), computed from the live row at render time.
 * When set, the button renders disabled with the reason — the card is never
 * hidden, and the button is never offered and then refused. A refusal that
 * does come back (the row changed since render) is shown in place, and cleared
 * whenever fresh props arrive.
 */
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { StrandCta } from '@/lib/mission-list-card';
import type { StrandButtonOrder } from '@/lib/strand-choice-decision';

function recordChoice(missionId: string, label: 'continue-on-runner' | 'wait-for-local', order: StrandButtonOrder, quietMs: number) {
  void fetch(`/api/missions/${encodeURIComponent(missionId)}/strand-choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, order, quietMs }),
  }).catch(() => {});
}

export default function ContinueOnRunnerCta({
  strand,
  order = strand.order ?? 'runner-first',
  className = '',
}: {
  strand: StrandCta;
  /** Which button leads. Defaults to `strand.order`; only a gated, confident decision ever changes it. */
  order?: StrandButtonOrder;
  className?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keptLocal, setKeptLocal] = useState(false);

  // Fresh props are a fresh answer: drop a refusal from an earlier tap.
  useEffect(() => { setError(null); }, [strand.blockedReason, strand.quietMs, strand.missionId]);

  const blocked = strand.blockedReason;
  const disabled = !!blocked || busy || isPending;

  async function continueOnRunner() {
    if (blocked) return;
    recordChoice(strand.missionId, 'continue-on-runner', order, strand.quietMs);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(strand.missionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executor: 'runner' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body?.error === 'string' ? body.error : 'Could not switch this mission to runners.');
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function keepLocal() {
    recordChoice(strand.missionId, 'wait-for-local', order, strand.quietMs);
    setKeptLocal(true);
  }

  const runnerButton = (
    <button
      key="runner"
      type="button"
      data-testid="strand-continue-on-runner"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); continueOnRunner(); }}
      disabled={disabled}
      aria-disabled={disabled}
      title={blocked ?? undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-1 px-3.5 font-mono text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        order === 'runner-first'
          ? 'border-2 border-primary bg-primary text-white hover:bg-primary-hover'
          : 'border border-border-strong text-text-primary hover:bg-surface-3'
      }`}
    >
      {busy || isPending ? 'Switching…' : 'Continue on a runner →'}
    </button>
  );
  const localButton = (
    <button
      key="local"
      type="button"
      data-testid="strand-keep-local"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); keepLocal(); }}
      disabled={busy || isPending}
      className={`inline-flex min-h-11 items-center justify-center px-3.5 font-mono text-[12.5px] transition-colors disabled:opacity-50 ${
        order === 'local-first'
          ? 'border-2 border-primary bg-primary font-semibold text-white hover:bg-primary-hover'
          : 'border border-border-strong text-text-secondary hover:bg-surface-3'
      }`}
    >
      Keep local
    </button>
  );

  return (
    <div data-testid="strand-cta" data-order={order} className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        {order === 'runner-first' ? [runnerButton, localButton] : [localButton, runnerButton]}
      </div>
      {blocked && (
        <p data-testid="strand-cta-blocked" className="font-mono text-[11.5px] leading-snug text-status-warning">
          Can&apos;t continue on a runner: {blocked}
        </p>
      )}
      {error && !blocked && (
        <p role="alert" className="font-mono text-[11.5px] leading-snug text-status-error">{error}</p>
      )}
      {keptLocal && strand.taskId && (
        <p data-testid="strand-keep-local-hint" className="font-mono text-[11.5px] leading-snug text-text-secondary [overflow-wrap:anywhere]">
          Kept local. From your session: <code className="text-text-primary">claim_task {'{'}taskId: &quot;{strand.taskId}&quot;{'}'}</code>
        </p>
      )}
    </div>
  );
}
