'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  INFERENCE_CAPABILITIES,
  ALL_INFERENCE_CAPABILITIES,
  type InferenceCapability,
} from '@buildd/core/inference-policy';
import { capabilityToggleCopy, FEATURE_TRADEOFF } from './feature-copy';

/**
 * Settings → AI: chat on or off, and which features call a model directly.
 *
 * Holding a provider key and spending it are separate decisions, so this is a
 * per-feature allowlist (`teams.enabledInferenceCapabilities`) that starts
 * empty. The tradeoff is the same for every row, so the page states it once.
 */
export default function ModelFeatures({ teamId, canManage, keysHref = '/app/settings/providers' }: {
  teamId: string;
  canManage: boolean;
  /** Where "add a key" goes. */
  keysHref?: string;
}) {
  const [enabled, setEnabled] = useState<InferenceCapability[]>([]);
  const [chatDisabled, setChatDisabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (res.ok) {
        const data = await res.json();
        const list = data.team?.enabledInferenceCapabilities as string[] | null | undefined;
        setEnabled(ALL_INFERENCE_CAPABILITIES.filter((c) => (list ?? []).includes(c)));
        setChatDisabled(data.team?.chatDisabled === true);
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoaded(true);
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  const isOn = (c: InferenceCapability) => enabled.includes(c);

  async function toggle(c: InferenceCapability) {
    const wasOn = isOn(c);
    const next = wasOn ? enabled.filter((x) => x !== c) : [...enabled, c];
    const ordered = ALL_INFERENCE_CAPABILITIES.filter((x) => next.includes(x));
    const prev = enabled;
    setEnabled(ordered); // optimistic
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledInferenceCapabilities: ordered }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to update');
      // `wasOn` is the state BEFORE the click: true means it was just turned off.
      const copy = capabilityToggleCopy(INFERENCE_CAPABILITIES[c], wasOn);
      setMsg({ type: 'success', text: wasOn ? copy.turnedOff : copy.turnedOn });
    } catch (e) {
      setEnabled(prev); // rollback
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update' });
    } finally {
      setBusy(false);
    }
  }

  // Chat is on whenever a key resolves; this is only the admin's off switch.
  async function toggleChat() {
    const next = !chatDisabled;
    setChatDisabled(next);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatDisabled: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to update');
      setMsg({ type: 'success', text: next ? 'Chat is off for the team.' : 'Chat is on for everyone with a key.' });
    } catch (e) {
      setChatDisabled(!next);
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to update' });
    } finally {
      setBusy(false);
    }
  }

  const features = ALL_INFERENCE_CAPABILITIES.filter((c) => c !== 'chat');

  const row = (c: InferenceCapability) => {
    const d = INFERENCE_CAPABILITIES[c];
    const on = isOn(c);
    const copy = capabilityToggleCopy(d, on);
    return (
      <div key={c} className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 px-4 py-3" data-testid={`capability-${c}`}>
        <span className="flex flex-col gap-1 min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
            <span aria-hidden className={`w-2 h-2 shrink-0 ${on ? 'bg-status-success' : 'bg-text-muted'}`} />
            {d.label}
            <span className="text-xs text-text-muted">{copy.meta}</span>
          </span>
          <span className="text-xs text-text-secondary">{d.description}</span>
          {copy.needsKeyHint && (
            <span className="text-xs text-text-secondary">
              Chat needs a provider key. <Link href={keysHref} className="underline text-text-primary hover:text-accent-text">Add one</Link>
            </span>
          )}
        </span>
        {canManage && (
          <button
            onClick={() => toggle(c)}
            disabled={busy || !loaded}
            className={`btn shrink-0 self-start ${on ? '' : 'btn-accent'}`}
          >
            {copy.button}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="ai-chat-h">
        <h2 id="ai-chat-h" className="section-label mb-3">Chat</h2>
        <div className="card flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3" data-testid="chat-switch">
          <span className="flex items-center gap-2 text-sm text-text-primary">
            <span aria-hidden className={`w-2 h-2 shrink-0 ${chatDisabled ? 'bg-text-muted' : 'bg-status-success'}`} />
            {chatDisabled ? 'Off for the team' : 'On for everyone with a key'}
            <Link href={keysHref} className="text-xs text-text-secondary underline hover:text-text-primary">Keys</Link>
          </span>
          {canManage && (
            <button onClick={toggleChat} disabled={busy || !loaded} className="btn btn-quiet self-start sm:self-auto">
              {chatDisabled ? 'Turn chat on' : 'Turn chat off'}
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="ai-features-h" id="inference-spending" className="scroll-mt-20">
        <h2 id="ai-features-h" className="section-label mb-3">Features that call a model</h2>
        <p className="text-xs text-text-secondary mb-3 max-w-prose">{FEATURE_TRADEOFF}</p>
        <div className="card divide-y divide-border-default">{features.map(row)}</div>
      </section>

      {!canManage && (
        <p className="text-xs text-text-muted">Only a team owner or admin can change these.</p>
      )}
      {msg && (
        <p role="status" className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</p>
      )}
    </div>
  );
}
