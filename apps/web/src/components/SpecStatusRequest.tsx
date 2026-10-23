'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import Lede from '@/components/ui/Lede';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import type { StatusRequestView } from '@/lib/specs/retire';

const CLOSED: Record<Exclude<StatusRequestView['state'], 'ready' | 'stale'>, { tone: 'warn' | 'err'; text: string }> = {
  invalid: { tone: 'err', text: 'This link is not valid.' },
  expired: { tone: 'warn', text: 'This link has expired. Ask for a new one.' },
  not_found: { tone: 'err', text: 'Spec not found.' },
  not_approver: { tone: 'warn', text: 'Only an owner, an admin or a named approver can retire or restore this spec.' },
};

/**
 * The confirm step for a retire or restore asked for from an OAuth session
 * (Living Spec b7fc9316 R-11, R-12): what changes, the reason given, and one
 * Confirm that sends the request to POST /api/specs/[specId]/retire/confirm
 * from this signed-in session. Closed states carry no action.
 */
export default function SpecStatusRequest({ specId, token, view }: { specId: string; token: string; view: StatusRequestView }) {
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (view.state !== 'ready') {
    return (
      <div className="flex flex-col gap-4">
        {view.state === 'stale' ? <h1 className="text-heading font-semibold text-text-primary [overflow-wrap:anywhere]">{view.title}</h1> : null}
        <Notice tone={view.state === 'stale' ? 'warn' : CLOSED[view.state].tone} data-testid="spec-status-state">
          {view.state === 'stale' ? `The spec changed since this was asked for: it is ${view.status} now. Nothing was changed. Ask again if it still applies.` : CLOSED[view.state].text}
        </Notice>
      </div>
    );
  }

  const verb = view.op === 'retire' ? (view.to === 'superseded' ? 'Mark superseded' : 'Retire') : 'Restore';
  const doneText = view.op === 'retire' ? `Done: the spec is ${view.to}.` : `Done: the spec is ${view.to} again.`;
  function confirm() {
    startTransition(async () => {
      const res = await fetch(`/api/specs/${encodeURIComponent(specId)}/retire/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: token }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => ({}))) as { error?: string; code?: string } | undefined;
      if (res?.ok) setResult({ tone: 'ok', text: doneText });
      else setResult({ tone: body?.code === 'request_stale' ? 'warn' : 'err', text: body?.error ?? 'That did not work. Try again.' });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-status-title">{view.title}</h1>
      <Lede>
        {view.op === 'retire'
          ? `${verb} this spec: it goes from ${view.from} to ${view.to} and leaves force. Restore undoes it.`
          : `Restore this spec: it goes from ${view.from} back to ${view.to}.`}
      </Lede>
      {view.supersededBy ? (
        <p className="text-body text-text-primary">
          Replaced by <Link href={`/app/specs/${encodeURIComponent(view.supersededBy.id)}`} className="underline underline-offset-2 [overflow-wrap:anywhere]">{view.supersededBy.title}</Link>.
        </p>
      ) : null}
      <section className="flex flex-col gap-1" aria-label="Reason">
        <h2 className="text-eyebrow font-semibold text-text-muted">Reason given</h2>
        <p className="text-body text-text-primary [overflow-wrap:anywhere]" data-testid="spec-status-reason">{view.reason}</p>
      </section>
      {result ? <Notice tone={result.tone} data-testid="spec-status-result">{result.text}</Notice> : null}
      {!result || result.tone === 'err' ? (
        <div>
          <PrimaryAction onClick={confirm} disabled={pending} fullWidthOnMobile data-testid="spec-status-confirm">
            {verb} spec
          </PrimaryAction>
        </div>
      ) : null}
    </div>
  );
}
