'use client';

/**
 * Settings › Profile › Passkeys: the signed-in person's passkeys, for the
 * check a team can require on spec approve, retire and restore (Living Spec
 * b7fc9316 R-20). Add runs the browser's passkey prompt and stores the result
 * (/api/passkeys/register); Remove deletes one. When a team of theirs requires
 * passkeys and they already have one, either act asks for an existing passkey
 * first (withPasskey). A refusal that names this page links here (#passkeys).
 */
import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import { withPasskey } from '@/lib/passkeys/client';

export interface PasskeyRow { id: string; name: string; createdAt: string; lastUsedAt: string | null }

// One fixed format on the server and in the browser, so the first render matches.
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string) => DAY.format(new Date(iso));
const ADD_FAILED = 'Could not add the passkey. Try again.';

/** A name for the passkey from the device it was made on; the person sees it in this list only. */
function deviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  for (const [re, name] of [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Mac OS X|Macintosh/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux']] as const) {
    if (re.test(ua)) return `Passkey on ${name}`;
  }
  return 'Passkey';
}

export default function PasskeysSection({ initial }: { initial: PasskeyRow[] }) {
  const [keys, setKeys] = useState(initial);
  const [busy, setBusy] = useState<null | 'add' | string>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => { setSupported(browserSupportsWebAuthn()); }, []);

  const add = async () => {
    setBusy('add');
    setMsg(null);
    try {
      const asked = await fetch('/api/passkeys/register/options', { method: 'POST' });
      const opts = (await asked.json().catch(() => ({}))) as { options?: Parameters<typeof startRegistration>[0]['optionsJSON']; error?: string };
      if (!asked.ok || !opts.options) throw new Error(opts.error ?? 'Could not start. Try again.');
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: opts.options });
      } catch {
        throw new Error('Passkey not added.');
      }
      const name = deviceName();
      const { res, body } = await withPasskey((presence) => fetch('/api/passkeys/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response, name, ...(presence ? { presence } : {}) }),
      }));
      if (!res?.ok) throw new Error(body.error ?? ADD_FAILED);
      setKeys((k) => [...k, body.passkey as PasskeyRow]);
      setMsg({ tone: 'ok', text: 'Passkey added.' });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : ADD_FAILED });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setMsg(null);
    const { res, body } = await withPasskey((presence) => fetch(`/api/passkeys/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presence ? { presence } : {}),
    }));
    setBusy(null);
    setConfirming(null);
    if (res?.ok) {
      setKeys((k) => k.filter((x) => x.id !== id));
      setMsg({ tone: 'ok', text: 'Passkey removed.' });
    } else setMsg({ tone: 'err', text: body.error ?? 'Could not remove the passkey. Try again.' });
  };

  return (
    <Section
      id="passkeys"
      title="Passkeys"
      action={supported ? (
        <button type="button" className="btn btn-sm h-11 md:h-6" onClick={add} disabled={busy !== null} data-testid="passkey-add">
          {busy === 'add' ? 'Adding…' : 'Add passkey'}
        </button>
      ) : undefined}
    >
      <div className="border-y border-border-default" data-testid="passkey-list">
        {keys.length === 0 ? (
          <p className="py-2.5 text-sm text-text-secondary">
            {supported ? 'No passkeys. A team can require one to approve, retire or restore a spec.' : 'This browser cannot use passkeys.'}
          </p>
        ) : keys.map((k, i) => (
          <div key={k.id} className={`flex min-h-14 items-center gap-3 py-2.5 ${i ? 'border-t border-[var(--line-soft)]' : ''}`} data-testid="passkey-row">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">{k.name}</p>
              <p className="text-meta text-text-muted">
                Added {day(k.createdAt)}{k.lastUsedAt ? ` · last used ${day(k.lastUsedAt)}` : ''}
              </p>
            </div>
            {confirming === k.id ? (
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn btn-sm btn-danger h-11 md:h-6" onClick={() => remove(k.id)} disabled={busy !== null}>
                  {busy === k.id ? 'Removing…' : 'Remove'}
                </button>
                <button type="button" className="btn btn-sm btn-quiet h-11 md:h-6" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancel</button>
              </div>
            ) : (
              <button type="button" className="btn btn-sm btn-quiet h-11 shrink-0 md:h-6" onClick={() => setConfirming(k.id)} disabled={busy !== null} data-testid="passkey-remove">
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {msg ? <Notice tone={msg.tone} className="mt-2" data-testid="passkey-message">{msg.text}</Notice> : null}
    </Section>
  );
}
