'use client';

/**
 * Settings › Team › Members › "Require a passkey": the team switch for spec
 * approve, retire and restore (Living Spec b7fc9316 R-20). Off by default. An
 * owner changes it, with their own passkey either way (PUT
 * /api/teams/[id]/spec-passkey, the prompt run by withPasskey); everyone else
 * sees it read-only, with who can change it.
 */
import Link from 'next/link';
import { useState } from 'react';
import Section from '@/components/ui/Section';
import Switch from '@/components/ui/Switch';
import { needsPasskey, withPasskey } from '@/lib/passkeys/client';
import { PASSKEY_SETTINGS_PATH } from '@/lib/passkeys/paths';

export default function SpecPasskeySetting({ teamId, initial, canChange }: { teamId: string; initial: boolean; canChange: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; addPasskey: boolean } | null>(null);

  const save = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const { res, body } = await withPasskey((presence) => fetch(`/api/teams/${encodeURIComponent(teamId)}/spec-passkey`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: next, ...(presence ? { presence } : {}) }),
    }));
    setBusy(false);
    if (res?.ok) setOn(body.required === true);
    else setError({ text: body.error ?? 'Could not save. Try again.', addPasskey: needsPasskey(body) });
  };

  return (
    <Section title="Spec approvals">
      <div className="flex min-h-14 items-start gap-4 border-y border-border-default py-2.5" data-testid="spec-passkey-setting">
        <div className="min-w-0 flex-1">
          <p id="spec-passkey-label" className="text-sm font-medium text-text-primary">Require a passkey</p>
          <p className="text-sm text-text-secondary">
            {canChange ? 'Asked for when anyone approves, retires or restores a spec.' : 'Only a team owner can change this.'}
          </p>
          {error ? (
            <p role="alert" className="mt-1 text-sm text-status-error">
              {error.text}
              {error.addPasskey ? <> <Link href={PASSKEY_SETTINGS_PATH} className="underline underline-offset-2">Add a passkey</Link></> : null}
            </p>
          ) : null}
        </div>
        <Switch
          labelledBy="spec-passkey-label"
          checked={on}
          onChange={(next) => { void save(next); }}
          disabled={busy || !canChange}
          className="mt-0.5"
        />
      </div>
    </Section>
  );
}
