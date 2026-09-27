'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CHAT_PROVIDER_INFO, checkKeyShape, type ChatProvider } from '@/lib/provider-keys-client';
import { setProviderKey } from '@/lib/provider-keys-api';
import ConnectOpenRouterButton, { providerFlowMessage } from '@/components/settings/ConnectOpenRouterButton';
import { Select } from '@/components/ui/Select';
import { useIsMobile } from '@/hooks/useIsMobile';

/** localStorage key for "Not now", per team. Resumable: the card folds, it never vanishes until done. */
export function onboardingFoldKey(teamId: string): string {
  return `buildd-chat-setup-folded:${teamId}`;
}

/**
 * Home, owners and admins only, while no key resolves: the one step between a
 * new team and chat. Three ways through, OpenRouter first. Members never see
 * this. It leaves Home once chat is available.
 */
export default function ProviderOnboardingCard({ teamId }: { teamId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const flow = providerFlowMessage(search);
  const isMobile = useIsMobile();
  const [folded, setFolded] = useState(false);
  const [provider, setProvider] = useState<ChatProvider>('openrouter');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'own'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    try { setFolded(window.localStorage.getItem(onboardingFoldKey(teamId)) === '1'); } catch { /* private mode */ }
  }, [teamId]);

  function fold(next: boolean) {
    setFolded(next);
    try {
      if (next) window.localStorage.setItem(onboardingFoldKey(teamId), '1');
      else window.localStorage.removeItem(onboardingFoldKey(teamId));
    } catch { /* ignore */ }
  }

  const shape = value ? checkKeyShape(provider, value) : null;
  const info = CHAT_PROVIDER_INFO.find((p) => p.id === provider)!;

  async function save() {
    const r = checkKeyShape(provider, value);
    if (!r.ok) { setMsg({ tone: 'err', text: r.message ?? 'That key does not look right.' }); return; }
    setBusy('save');
    setMsg(null);
    try {
      await setProviderKey(teamId, provider, 'team', r.value);
      setValue('');
      router.refresh();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save the key.' });
    } finally {
      setBusy(null);
    }
  }

  async function everyoneOwn() {
    setBusy('own');
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inferenceKeyPolicy: 'own' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      router.refresh();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setBusy(null);
    }
  }

  if (folded) {
    return (
      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-2 border-dashed border-border-strong bg-card px-4 py-2.5 text-sm" data-testid="provider-onboarding" data-folded="true">
        <span className="section-label !text-accent-text">Chat setup · 1 of 2</span>
        <span className="text-text-secondary">Connect a model provider</span>
        <button type="button" className="ml-auto underline text-accent-text hover:no-underline" onClick={() => fold(false)}>Resume</button>
      </div>
    );
  }

  const pasteKeyOption = (
    <li className="px-5 py-4 space-y-2">
      <span className="block text-sm font-semibold text-text-primary">Paste a key</span>
      <div className="flex flex-col sm:flex-row gap-2">
        <Select
          aria-label="Provider"
          value={provider}
          onChange={(v) => { setProvider(v as ChatProvider); setMsg(null); }}
          options={CHAT_PROVIDER_INFO.map((p) => ({ value: p.id, label: p.label }))}
          className="sm:w-40 shrink-0"
        />
        <input
          type="password"
          aria-label={`${info.label} API key`}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={info.placeholder}
          className="h-10 flex-1 min-w-0 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-sm"
        />
        <button type="button" className="btn h-10" onClick={save} disabled={busy !== null || !value.trim() || shape?.ok === false}>
          {busy === 'save' ? 'Testing…' : 'Save and test'}
        </button>
      </div>
      {shape?.message && <p className={`text-xs ${shape.ok ? 'text-status-warning' : 'text-status-error'}`}>{shape.message}</p>}
      <p className="text-xs text-text-muted">Goes in as the team key. buildd tests it with {info.label} before saving, and nobody can read it back.</p>
    </li>
  );

  const personalKeysOption = (
    <li className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4">
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-text-primary">Let each person connect their own</span>
        <span className="block text-xs text-text-secondary mt-0.5">No team key. Everyone adds their own before chat works for them.</span>
      </span>
      <button type="button" className="btn" onClick={everyoneOwn} disabled={busy !== null}>
        {busy === 'own' ? 'Saving…' : 'Use personal keys'}
      </button>
    </li>
  );

  return (
    <section className="mb-8 pb-16 md:pb-0 border-2 border-border-strong bg-card shadow-[var(--card-shadow)]" data-testid="provider-onboarding" data-folded="false" aria-labelledby="provider-onboarding-h">
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <div className="section-label !text-accent-text">Chat setup · 1 of 2</div>
          <h2 id="provider-onboarding-h" className="mt-1.5 text-[17px] font-semibold text-text-primary">Connect a model provider</h2>
          <p className="mt-1 text-sm text-text-secondary">Chat is where your team starts work. It runs on an API key, billed per token.</p>
        </div>
        <button type="button" className="btn btn-quiet shrink-0" onClick={() => fold(true)}>Not now</button>
      </div>

      {flow && (
        <p role={flow.tone === 'err' ? 'alert' : 'status'} className={`mx-5 mt-3 text-sm ${flow.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{flow.text}</p>
      )}

      <ol className="mt-4 divide-y divide-border-default border-t border-border-default">
        <li className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4">
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-text-primary">OpenRouter <span className="ml-1 text-[11px] font-semibold uppercase tracking-[1px] text-accent-text">recommended</span></span>
            <span className="block text-xs text-text-secondary mt-0.5">One key reaches every model. OpenRouter makes it in your account, so there is nothing to paste.</span>
          </span>
          <ConnectOpenRouterButton scope="team" teamId={teamId} returnTo="/app/home" />
        </li>

        {isMobile ? (
          <li className="px-5 py-4">
            <details className="group">
              <summary className="cursor-pointer text-sm font-semibold text-text-primary list-none flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-3 group-open:rotate-90 transition-transform">▸</span> More ways to connect
              </summary>
              <ol className="mt-3 -mx-5 divide-y divide-border-default border-t border-border-default">
                {pasteKeyOption}
                {personalKeysOption}
              </ol>
            </details>
          </li>
        ) : (
          <>
            {pasteKeyOption}
            {personalKeysOption}
          </>
        )}
      </ol>

      <div className="flex items-center gap-2 border-t border-border-default px-5 py-3 text-xs text-text-muted">
        <span aria-hidden className="w-2 h-2 border-2 border-text-secondary" />
        2 of 2 · Talk to your agent. Chat opens here as soon as a key works.
      </div>

      {msg && <p role="alert" className={`px-5 pb-4 text-sm ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</p>}
    </section>
  );
}
