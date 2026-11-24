'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ListProvidersResponse, ProviderAssignmentsResponse, ProviderEmbeddingResponse, ProviderLocalRunnerResponse, ProviderSurfaceId } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';
import { AUTOMATIC, EMBEDDING_REINDEX_LINE, embeddingChoices, embeddingView, loneProviderLine, localModelOptions, usedForView } from './providers-view';

import { EMBEDDING_MODEL_PLACEHOLDER, type EmbeddingCredentialProvider } from '@buildd/core/providers/embedding';

/** Sized and bordered like the Select beside it (triggerClasses 'md'). */
const INPUT = 'w-full min-h-11 md:min-h-9 px-3 bg-surface-1 border-2 border-border-strong focus:border-primary outline-none font-mono text-base md:text-xs';

/**
 * Which connected provider serves each surface. With one provider connected
 * there is nothing to choose: one line says what it is used for. With two or
 * more, one picker per surface (`teams.provider_assignments`, PATCH
 * /api/providers/assignments); an option a surface cannot use is disabled with
 * what it needs. `decisions` is the decision model row (a platform operator's
 * only; absent for everyone else), drawn under the pickers, or under the one
 * line when there are none. `extra` is the Claude / Codex switch, drawn only
 * with the table. The Embeddings row (`/api/providers/embedding`) shows once a
 * provider with an embeddings endpoint is connected: Voyage, the default, or
 * that provider plus a model id. Its key is the provider's stored one.
 */
export default function UsedForSection({ teamId, data, canManage, decisions, extra, local = null, onLocalChanged }: {
  teamId: string;
  data: ListProvidersResponse;
  canManage: boolean;
  /** The team's runners and pick, for the Embeddings row's Local runner option. */
  local?: ProviderLocalRunnerResponse | null;
  onLocalChanged?: () => Promise<void> | void;
  decisions?: ReactNode;
  extra?: ReactNode;
}) {
  const [assignments, setAssignments] = useState<ProviderAssignmentsResponse['assignments'] | null>(null);
  const [busy, setBusy] = useState<ProviderSurfaceId | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/providers/assignments?teamId=${encodeURIComponent(teamId)}`, { cache: 'no-store' }).catch(() => null);
    setAssignments(res?.ok ? ((await res.json().catch(() => ({}))) as Partial<ProviderAssignmentsResponse>).assignments ?? {} : {});
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  const [embedding, setEmbedding] = useState<ProviderEmbeddingResponse | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/providers/embedding?teamId=${encodeURIComponent(teamId)}`, { cache: 'no-store' }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as ProviderEmbeddingResponse | null) : null;
      if (live) setEmbedding({ provider: body?.provider ?? null, model: body?.model ?? null });
    })();
    return () => { live = false; };
  }, [teamId]);

  const lone = loneProviderLine(data);
  const rows = assignments ? usedForView(data, assignments) : null;
  const embeddingRow = embedding ? embeddingView(data, embedding, local) : null;

  async function pick(surface: ProviderSurfaceId, provider: string) {
    setBusy(surface);
    setErr(null);
    try {
      const res = await fetch('/api/providers/assignments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, surface, provider: provider === AUTOMATIC ? null : provider }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProviderAssignmentsResponse> & { error?: string };
      if (!res.ok || !body.assignments) throw new Error(body.error ?? 'Could not save');
      setAssignments(body.assignments);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  const loneLine = lone && <p className="text-body text-text-secondary" data-testid="provider-lone">{lone}</p>;
  // Fewer than two providers: no pickers, but the Embeddings row and an operator's Decisions row still show.
  if (!rows && !decisions && !embeddingRow) return loneLine || null;

  return (
    <Section title="Used for" id="used-for" className="scroll-mt-20">
      {!rows && loneLine && <div className="mb-3">{loneLine}</div>}
      <dl className="border-y border-border-default divide-y divide-border-default" data-testid={rows ? 'used-for' : 'used-for-decisions-only'}>
        {rows?.map((r) => (
          <div key={r.surface} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2 min-h-12" data-testid={`used-for-${r.surface}`}>
            <dt className="w-full sm:w-36 shrink-0 text-body text-text-primary">{r.label}</dt>
            <dd className="w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-72">
              <Select
                value={r.value ?? AUTOMATIC}
                onChange={(v) => { void pick(r.surface, v); }}
                disabled={!canManage || busy !== null}
                aria-label={r.label}
                sheetTitle={r.label}
                testId={`used-for-pick-${r.surface}`}
                options={[{ value: AUTOMATIC, label: 'Automatic' }, ...r.options]}
              />
            </dd>
          </div>
        ))}
        {embeddingRow && embedding && (
          <EmbeddingRowItem teamId={teamId} row={embeddingRow} canManage={canManage} onSaved={setEmbedding} local={local} onLocalChanged={onLocalChanged} />
        )}
        {decisions && <div className="py-2" data-testid="used-for-decisions">{decisions}</div>}
      </dl>
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
      {extra && <div className="mt-4">{extra}</div>}
    </Section>
  );
}

/** Embeddings: provider, and for anything but Voyage a model id with Save. */
function EmbeddingRowItem({ teamId, row, canManage, onSaved, local, onLocalChanged }: {
  teamId: string;
  row: NonNullable<ReturnType<typeof embeddingView>>;
  canManage: boolean;
  onSaved: (next: ProviderEmbeddingResponse) => void;
  local: ProviderLocalRunnerResponse | null;
  onLocalChanged?: () => Promise<void> | void;
}) {
  const [provider, setProvider] = useState<string>(row.value);
  const [model, setModel] = useState(row.model ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changedModel, setChangedModel] = useState(false);
  const onRunner = provider === 'local_runner';
  const choices = embeddingChoices(local);
  const [runnerId, setRunnerId] = useState<string>(local?.runnerId ?? '');
  const [runnerModel, setRunnerModel] = useState<string>(row.value === 'local_runner' ? row.model ?? '' : '');
  const [queued, setQueued] = useState<number | null>(null);
  const needsModel = provider !== 'voyage' && !onRunner;
  const runnerDirty = onRunner && (row.value !== 'local_runner' || runnerId !== (local?.runnerId ?? '') || runnerModel !== (row.model ?? ''));
  const dirty = onRunner ? runnerDirty : provider !== row.value || (needsModel && model.trim() !== (row.model ?? ''));

  async function saveRunner() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers/local-runner', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, runnerId, embedModel: runnerModel }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProviderLocalRunnerResponse> & { error?: string };
      if (!res.ok || body.runners === undefined) throw new Error(body.error ?? 'Could not save. Try again.');
      setChangedModel(true);
      setQueued(body.reembedQueued ?? null);
      onSaved({ provider: 'local_runner', model: body.embedModel ?? runnerModel });
      await onLocalChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function save(nextProvider: string, nextModel: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/providers/embedding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, provider: nextProvider, model: nextProvider === 'voyage' ? undefined : nextModel.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ProviderEmbeddingResponse> & { error?: string };
      if (!res.ok || body.provider === undefined) throw new Error(body.error ?? 'Could not save. Try again.');
      setChangedModel(true);
      onSaved({ provider: body.provider ?? null, model: body.model ?? null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-2 min-h-12" data-testid="used-for-embedding">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <dt className="w-full sm:w-36 shrink-0 text-body text-text-primary">Embeddings</dt>
        <dd className="w-full min-w-0 sm:w-auto sm:flex-1 flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-auto sm:flex-1 sm:max-w-72">
            <Select
              value={provider}
              onChange={(v) => {
                setProvider(v);
                setErr(null);
                if (v === 'voyage' && row.value !== 'voyage') void save('voyage', '');
              }}
              disabled={!canManage || busy}
              aria-label="Embeddings"
              sheetTitle="Embeddings"
              testId="used-for-pick-embedding"
              options={row.options}
            />
          </div>
          {onRunner && (
            <>
              <div className="w-full sm:w-auto sm:flex-1 sm:max-w-72">
                <Select
                  value={runnerId}
                  onChange={(v) => { setRunnerId(v); setRunnerModel(''); setErr(null); }}
                  disabled={!canManage || busy}
                  aria-label="Runner"
                  sheetTitle="Runner"
                  testId="used-for-embedding-runner"
                  placeholder="Choose a runner"
                  options={choices.map((r) => ({ value: r.id, label: `${r.name} · ${r.online ? 'Online' : 'Offline'}`, disabled: false }))}
                />
              </div>
              <div className="w-full sm:w-auto sm:flex-1 sm:max-w-72">
                <Select
                  value={runnerModel}
                  onChange={(v) => { setRunnerModel(v); setErr(null); }}
                  disabled={!canManage || busy || !runnerId}
                  aria-label="Embedding model"
                  sheetTitle="Embedding model"
                  testId="used-for-embedding-runner-model"
                  placeholder="Choose a model"
                  options={localModelOptions(choices.find((r) => r.id === runnerId), 'embedding')}
                />
              </div>
              {canManage && dirty && (
                <button className="btn btn-primary" onClick={() => void saveRunner()} disabled={busy || !runnerId || !runnerModel} data-testid="used-for-embedding-runner-save">
                  Save
                </button>
              )}
            </>
          )}
          {needsModel && (
            <>
              <input
                aria-label="Embedding model"
                data-testid="used-for-embedding-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={EMBEDDING_MODEL_PLACEHOLDER[provider as EmbeddingCredentialProvider] ?? ''}
                disabled={!canManage || busy}
                spellCheck={false}
                className={`${INPUT} sm:flex-1 sm:max-w-72`}
              />
              {canManage && dirty && (
                <button className="btn btn-primary" onClick={() => void save(provider, model)} disabled={busy || !model.trim()} data-testid="used-for-embedding-save">
                  Save
                </button>
              )}
            </>
          )}
        </dd>
      </div>
      {changedModel && !err && <p className="text-meta text-text-secondary mt-1.5" data-testid="used-for-embedding-reindex">{queued ? `${queued} ${queued === 1 ? 'index' : 'indexes'} will be embedded again. ` : ''}{EMBEDDING_REINDEX_LINE}</p>}
      {err && <p role="alert" className="text-meta text-status-error mt-1.5">{err}</p>}
    </div>
  );
}
