'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ProviderLocalRunnerResponse } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import { LOCAL_RUNNER_HINT, lastCallLine, localModelOptions, localRunnerCardView, runnerStateWord } from './providers-view';

const TONE = { error: 'text-status-error', success: 'text-status-success', muted: 'text-text-muted' } as const;
const NONE = '';

/** Reads `GET /api/providers/local-runner`; null until loaded or when the read fails. */
export function useLocalRunner(teamId: string): { data: ProviderLocalRunnerResponse | null; reload: () => Promise<void>; set: (d: ProviderLocalRunnerResponse) => void } {
  const [data, setData] = useState<ProviderLocalRunnerResponse | null>(null);
  const reload = useCallback(async () => {
    const res = await fetch(`/api/providers/local-runner?teamId=${encodeURIComponent(teamId)}`, { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as ProviderLocalRunnerResponse | null) : null;
    setData(body && Array.isArray(body.runners) ? body : null);
  }, [teamId]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, reload, set: setData };
}

/**
 * The "Local runner" row of Settings › Providers (local-runner-provider §7.3):
 * which of the team's runners serves chat and search from its own Ollama, with
 * which chat model, whether that runner is online and when it last answered a
 * call. No key: nothing is stored but the pick. With no runner that has
 * advertised models there is no row, only a line on how to get one.
 */
export default function LocalRunnerRow({ teamId, canManage, open, onToggle, local }: {
  teamId: string;
  canManage: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  local: ReturnType<typeof useLocalRunner>;
}) {
  const { data } = local;
  const [runnerId, setRunnerId] = useState<string>(NONE);
  const [chatModel, setChatModel] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRunnerId(data?.runnerId ?? NONE);
    setChatModel(data?.chatModel ?? NONE);
  }, [data?.runnerId, data?.chatModel]);

  if (!data) return null;
  const view = localRunnerCardView(data);
  if (view.empty) {
    return <li className="py-3 text-meta text-text-muted" data-testid="local-runner-hint">{LOCAL_RUNNER_HINT}</li>;
  }

  const chosen = view.runners.find((r) => r.id === runnerId);
  const chatOptions = localModelOptions(chosen, 'completion');
  const dirty = runnerId !== (data.runnerId ?? NONE) || chatModel !== (data.chatModel ?? NONE);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers/local-runner', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, runnerId, chatModel: chatModel || null }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProviderLocalRunnerResponse> & { error?: string };
      if (!res.ok || body.runners === undefined) throw new Error(body.error ?? 'Could not save. Try again.');
      local.set(body as ProviderLocalRunnerResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="provider-card-local-runner" data-set={data.runnerId ? 'true' : 'false'}>
      <div className="flex items-center gap-3 min-h-12 py-1.5">
        <button
          type="button"
          className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-left min-h-11"
          aria-expanded={open}
          data-testid="provider-row-toggle"
          onClick={() => onToggle(!open)}
        >
          <span className="text-body font-semibold text-text-primary">Local runner</span>
          {view.state && <span className={`text-meta ${TONE[view.state.tone]}`} data-testid="local-runner-state">{view.state.word}</span>}
        </button>
        {!data.runnerId && !open && (
          <button type="button" className="btn shrink-0 min-h-11 md:min-h-0" onClick={() => onToggle(true)}>Set up</button>
        )}
      </div>

      {open && (
        <div className="pb-3 space-y-3 text-body" data-testid="provider-detail">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="w-full sm:w-36 shrink-0 text-body text-text-primary">Runner</span>
            <div className="w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-72">
              <Select
                value={runnerId}
                onChange={(v) => { setRunnerId(v); setChatModel(NONE); setErr(null); }}
                disabled={!canManage || busy}
                aria-label="Runner"
                sheetTitle="Runner"
                testId="local-runner-pick-runner"
                placeholder="Choose a runner"
                options={view.runners.map((r) => ({ value: r.id, label: `${r.name} · ${runnerStateWord(r.online)}`, disabled: false }))}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="w-full sm:w-36 shrink-0 text-body text-text-primary">Chat model</span>
            <div className="w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-72">
              <Select
                value={chatModel}
                onChange={(v) => { setChatModel(v); setErr(null); }}
                disabled={!canManage || busy || !chosen}
                aria-label="Chat model"
                sheetTitle="Chat model"
                testId="local-runner-pick-chat"
                placeholder={chatOptions.length ? 'Choose a model' : 'No chat models'}
                options={[{ value: NONE, label: 'None' }, ...chatOptions]}
              />
            </div>
          </div>
          {data.runnerId && (
            <p className="text-meta text-text-secondary" data-testid="local-runner-last-call">
              {data.runner?.online ? 'Online' : data.runner ? 'Offline' : 'Runner gone'} · {lastCallLine(data.lastSuccessAt)}
            </p>
          )}
          {canManage && dirty && runnerId && (
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy} data-testid="local-runner-save">Save</button>
          )}
          {!canManage && <p className="text-meta text-text-muted">Admins can change this.</p>}
          {err && <p role="alert" className="text-meta text-status-error">{err}</p>}
        </div>
      )}
    </li>
  );
}
