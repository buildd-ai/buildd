'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { TEAM_PLAN_MIN_SEATS } from '@buildd/core/entitlements';

/** POST a billing route; resolve to its JSON, or throw its error message. */
async function postBilling(teamId: string, path: 'checkout' | 'portal' | 'seats', body: unknown = {}): Promise<any> {
  const res = await fetch(`/api/teams/${teamId}/billing/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function useRedirectAction(run: () => Promise<{ url: string }>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setPending(true);
    setError(null);
    try {
      const { url } = await run();
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setPending(false);
    }
  };
  return { pending, error, go };
}

export function UpgradeButton({ teamId, plan, seats, primary }: { teamId: string; plan: 'pro' | 'team'; seats?: number; primary: boolean }) {
  const { pending, error, go } = useRedirectAction(() => postBilling(teamId, 'checkout', { plan, seats }));
  const label = plan === 'team' ? 'Choose Team' : 'Choose Pro';
  return (
    <div className="space-y-2">
      {primary
        ? <PrimaryAction onClick={go} pending={pending} fullWidthOnMobile data-testid={`billing-upgrade-${plan}`}>{label}</PrimaryAction>
        : <button type="button" className="btn btn-lg h-11 md:h-10 w-full md:w-auto" onClick={go} disabled={pending} data-testid={`billing-upgrade-${plan}`}>{label}</button>}
      {error && <p className="notice notice-err text-xs">{error}</p>}
    </div>
  );
}

export function ManageBillingButton({ teamId, primary }: { teamId: string; primary: boolean }) {
  const { pending, error, go } = useRedirectAction(() => postBilling(teamId, 'portal'));
  return (
    <div className="space-y-2">
      {primary
        ? <PrimaryAction onClick={go} pending={pending} fullWidthOnMobile data-testid="billing-manage">Manage billing</PrimaryAction>
        : <button type="button" className="btn btn-lg h-11 md:h-10 w-full md:w-auto" onClick={go} disabled={pending} data-testid="billing-manage">Manage billing</button>}
      {error && <p className="notice notice-err text-xs">{error}</p>}
    </div>
  );
}

/**
 * The Team plan's seat count. Where an owner lands when an invite is refused
 * for want of a seat: adding seats is their explicit choice, prorated by
 * Stripe, and the page shows the new count once the webhook records it.
 */
export function SeatsForm({ teamId, paidSeats, used }: { teamId: string; paidSeats: number; used: number }) {
  const router = useRouter();
  const min = Math.max(TEAM_PLAN_MIN_SEATS, used);
  const [seats, setSeats] = useState(Math.max(paidSeats, min));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await postBilling(teamId, 'seats', { seats });
      setMessage({ ok: true, text: `Members set to ${seats}. The total updates once Stripe confirms.` });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={save} className="border border-border-default bg-card p-4 space-y-3" data-testid="billing-seats-form">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="field-label">Members</span>
          <input
            type="number"
            inputMode="numeric"
            min={min}
            step={1}
            value={seats}
            onChange={(e) => setSeats(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="w-28 h-11 md:h-10 px-3 bg-surface-1 text-text-primary"
            data-testid="billing-seats-input"
          />
        </label>
        <button type="submit" className="btn btn-lg h-11 md:h-10" disabled={pending || seats === paidSeats || seats < min}>
          {pending ? 'Saving' : 'Update members'}
        </button>
      </div>
      <p className="text-meta text-text-muted">At least {min}. Changes are prorated on the next invoice.</p>
      {message && <p className={`notice ${message.ok ? 'notice-ok' : 'notice-err'} text-xs`}>{message.text}</p>}
    </form>
  );
}
