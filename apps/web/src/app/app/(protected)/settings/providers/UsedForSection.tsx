'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ListProvidersResponse, ProviderAssignmentsResponse, ProviderEmbeddingResponse, ProviderSurfaceId } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';
import { AUTOMATIC, EMBEDDING_REINDEX_LINE, embeddingView, loneProviderLine, usedForView } from './providers-view';

import { EMBEDDING_MODEL_PLACEHOLDER, type EmbeddingCredentialProvider } from '@buildd/core/providers/embedding';

const INPUT = 'w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs';

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
export default function UsedForSection({ teamId, data, canManage, decisions, extra }: {
  teamId: string;
  data: ListProvidersResponse;
  canManage: boolean;
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
  const embeddingRow = embedding ? embeddingView(data, embedding) : null;

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
          <EmbeddingRowItem teamId={teamId} row={embeddingRow} canManage={canManage} onSaved={setEmbedding} />
        )}
        {decisions && <div className="py-2" data-testid="used-for-decisions">{decisions}</div>}
      </dl>
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
      {extra && <div className="mt-4">{extra}</div>}
    </Section>
  );
}

/** Embeddings: provider, and for anything but Voyage a model id with Save. */
function EmbeddingRowItem({ teamId, row, canManage, onSaved }: {
  teamId: string;
  row: NonNullable<ReturnType<typeof embeddingView>>;
  canManage: boolean;
  onSaved: (next: ProviderEmbeddingResponse) => void;
}) {
  const [provider, setProvider] = useState<string>(row.value);
  const [model, setModel] = useState(row.model ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changedModel, setChangedModel] = useState(false);
  const needsModel = provider !== 'voyage';
  const dirty = provider !== row.value || (needsModel && model.trim() !== (row.model ?? ''));

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
      {changedModel && !err && <p className="text-meta text-text-secondary mt-1.5" data-testid="used-for-embedding-reindex">{EMBEDDING_REINDEX_LINE}</p>}
      {err && <p role="alert" className="text-meta text-status-error mt-1.5">{err}</p>}
    </div>
  );
}
