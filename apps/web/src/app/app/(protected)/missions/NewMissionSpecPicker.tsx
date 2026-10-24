'use client';

/**
 * The specs a new mission makes true (Living Specs D-41): chosen before the
 * mission exists, sent with `POST /api/missions { outcomeSpec: [...] }`. Each
 * spec is pinned at its approved revision (else its head, proposed) and
 * scoped to the requirements that revision adds or changes, the same list the
 * server stores (lib/specs/selection-scope.ts). One entry per spec.
 */
import { useEffect, useState } from 'react';
import type { ChangeLine } from '@buildd/spec-contract/criterion-review';
import { Select, type SelectOption } from '@/components/ui/Select';
import { changedCriteria } from '@/lib/specs/selection-scope';
import { specOptionDescription } from './[id]/OutcomeSpecPicker';

interface SpecOption { id: string; title: string; status: string; headRevision: number; approvedRevision: number | null }

export interface ChosenSpec {
  specId: string;
  title: string;
  revision: number;
  /** The requirements this mission answers for; `all` for a first revision. Null while loading. */
  requirements: Array<{ id: string; text: string }> | 'all' | null;
  error?: string;
}

const LINK = 'min-h-11 md:min-h-0 inline-flex items-center text-meta text-text-muted hover:text-text-primary underline underline-offset-2 touch-manipulation';

/** The revision a choice pins: the approved one, else the head. */
export const pinnedRevisionOf = (s: Pick<SpecOption, 'headRevision' | 'approvedRevision'>) => s.approvedRevision ?? s.headRevision;

/** Specs a mission may still choose: not retired, not superseded, not already chosen. */
export function choosableSpecs(specs: readonly SpecOption[], chosen: readonly ChosenSpec[]): SpecOption[] {
  const taken = new Set(chosen.map((c) => c.specId));
  return specs.filter((s) => s.status !== 'superseded' && s.status !== 'retired' && !taken.has(s.id));
}

/** The request field for the chosen specs, pinned at the revision shown; undefined when none. */
export function outcomeSpecPayload(chosen: readonly ChosenSpec[]): Array<{ specId: string; revision: number }> | undefined {
  return chosen.length ? chosen.map((c) => ({ specId: c.specId, revision: c.revision })) : undefined;
}

/** A spec whose revision adds or changes no requirement cannot be chosen at create: the server refuses it. */
export function chosenProblem(c: ChosenSpec): string | null {
  if (c.error) return c.error;
  if (Array.isArray(c.requirements) && c.requirements.length === 0) return `Revision ${c.revision} adds or changes no requirement, so there is nothing for this mission to make true.`;
  return null;
}

export function ChosenSpecList({ chosen, onRemove }: { chosen: readonly ChosenSpec[]; onRemove?: (specId: string) => void }) {
  if (chosen.length === 0) return null;
  return (
    <div data-testid="new-mission-spec-list">
      <p className="text-meta text-text-secondary mb-1">This mission makes these requirements true:</p>
      <ul className="space-y-3">
        {chosen.map((c) => {
          const problem = chosenProblem(c);
          return (
            <li key={c.specId} data-testid="new-mission-spec">
              <div className="flex items-center gap-2">
                <span className="text-meta text-text-primary font-medium">From {c.title}</span>
                {onRemove && (
                  <button type="button" className={`${LINK} min-w-11 md:min-w-0 justify-center`} onClick={() => onRemove(c.specId)} aria-label={`Remove ${c.title}`}>Remove</button>
                )}
              </div>
              {c.requirements === null && !problem && <p className="text-meta text-text-muted">Loading its requirements</p>}
              {c.requirements === 'all' && <p className="text-meta text-text-muted">All of its requirements (its first revision)</p>}
              {Array.isArray(c.requirements) && c.requirements.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {c.requirements.map((r) => (
                    <li key={r.id} className="text-meta text-text-secondary leading-snug">
                      <span className="font-mono text-text-muted">{r.id}</span> {r.text}
                    </li>
                  ))}
                </ul>
              )}
              {problem && <p role="alert" className="text-meta text-status-error leading-snug">{problem}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function NewMissionSpecPicker({ workspaceId, chosen, onChange }: {
  workspaceId: string;
  chosen: ChosenSpec[];
  onChange: (next: ChosenSpec[] | ((prev: ChosenSpec[]) => ChosenSpec[])) => void;
}) {
  const [specs, setSpecs] = useState<SpecOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSpecs(null);
    setError(null);
    if (!workspaceId) return;
    let live = true;
    fetch(`/api/specs?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setError(typeof body.error === 'string' ? body.error : 'Could not load the specs.');
        else setSpecs(body.specs ?? []);
      })
      .catch(() => { if (live) setError('Could not reach buildd.'); });
    return () => { live = false; };
  }, [workspaceId]);

  async function choose(specId: string) {
    const s = specs?.find((x) => x.id === specId);
    if (!s) return;
    const revision = pinnedRevisionOf(s);
    onChange((prev) => [...prev, { specId, title: s.title, revision, requirements: revision === 1 ? 'all' : null }]);
    if (revision === 1) return;
    const set = (patch: Partial<ChosenSpec>) => onChange((prev) => prev.map((c) => (c.specId === specId ? { ...c, ...patch } : c)));
    try {
      const res = await fetch(`/api/specs/${specId}/diff?from=${revision - 1}&to=${revision}`, { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      const lines = body?.changes?.lines as ChangeLine[] | undefined;
      if (!res.ok || !lines) set({ error: 'Could not read what this revision changes.' });
      else set({ requirements: changedCriteria(lines) });
    } catch {
      set({ error: 'Could not reach buildd.' });
    }
  }

  if (!workspaceId) return <p className="text-xs text-text-muted/80">Choose a workspace to pick the specs this mission makes true.</p>;

  const options: SelectOption[] = choosableSpecs(specs ?? [], chosen).map((s) => ({ value: s.id, label: s.title, description: specOptionDescription(s) }));
  return (
    <div className="space-y-2" data-testid="new-mission-spec-picker">
      <ChosenSpecList chosen={chosen} onRemove={(id) => onChange((prev) => prev.filter((c) => c.specId !== id))} />
      <Select
        value=""
        onChange={(id) => { if (id) void choose(id); }}
        options={options}
        placeholder={specs ? (options.length ? (chosen.length ? 'Add another spec' : 'Choose a spec') : 'No other specs in this workspace') : 'Loading specs'}
        disabled={!specs || options.length === 0}
        searchable
        aria-label="Spec this mission makes true"
        testId="new-mission-spec-select"
      />
      {error && <p role="alert" className="text-meta text-status-error leading-snug">{error}</p>}
    </div>
  );
}
