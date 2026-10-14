'use client';

/**
 * Choosing the mission's outcome spec (Living Specs Slice 12, D-19, R-49):
 * the spec, its revision and, optionally, the requirements this mission
 * answers for with the reason. One write path, `PATCH /api/missions/[id]
 * { outcomeSpec }`: the server pins the revision and adds the required
 * criterion. Choosing it again with the same values changes nothing.
 *
 * Waiving a requirement and removing the outcome spec live on the criterion
 * row (OutcomeSpecCriterion), each with a reason.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LivingSpecGoalCriterion } from '@buildd/shared';
import { Select, type SelectOption } from '@/components/ui/Select';
import { countWord } from '@/lib/mission-outcome-spec-view';

interface SpecOption { id: string; title: string; status: string; headRevision: number; approvedRevision: number | null }

const FIELD = 'mt-1 block w-full min-h-11 md:min-h-0 px-2 py-1.5 text-body bg-surface-2';
const BUTTON = 'btn min-h-11 md:min-h-0 disabled:opacity-40 touch-manipulation';
const LINK = 'min-h-11 md:min-h-0 inline-flex items-center text-meta text-text-muted hover:text-text-primary underline underline-offset-2 touch-manipulation';

/** A spec's option line: which revision a choice would pin. */
export function specOptionDescription(s: SpecOption): string {
  if (s.approvedRevision) return `Revision ${s.approvedRevision} approved${s.headRevision > s.approvedRevision ? `, revision ${s.headRevision} proposed` : ''}`;
  return `Revision ${s.headRevision}, proposed`;
}

/**
 * The request body for a choice; null when it is not complete. With `current`
 * (changing an existing selection) a revision is sent only when it differs:
 * the server reads any sent revision as a repin, which drops the waivers. An
 * unticked narrowed scope is sent as `criteria: null`, which clears it;
 * leaving it out would keep it.
 */
export function outcomeSpecBody(input: { specId: string; revision: string; narrow: boolean; criteria: string; reason: string; current?: LivingSpecGoalCriterion | null }): Record<string, unknown> | null {
  if (!input.specId) return null;
  const current = input.current && input.current.specId === input.specId ? input.current : null;
  const body: Record<string, unknown> = { specId: input.specId };
  const rev = input.revision.trim();
  if (rev) {
    const n = Number(rev);
    if (!Number.isInteger(n) || n < 1) return null;
    if (!current || n !== current.revision) body.revision = n;
  }
  if (input.narrow) {
    const ids = input.criteria.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (ids.length === 0 || input.reason.trim().length < 10) return null;
    body.criteria = ids;
    body.narrowedReason = input.reason.trim();
  } else if (current?.criteria) {
    body.criteria = null;
  }
  return body;
}

/** What a repin clears, said before it happens; null when nothing is lost. */
export function repinWarning(body: Record<string, unknown> | null, current: LivingSpecGoalCriterion | null | undefined): string | null {
  if (!body || !current || body.specId !== current.specId || typeof body.revision !== 'number') return null;
  const n = current.waived?.length ?? 0;
  if (n === 0) return null;
  return `Revision ${body.revision} clears ${n === 1 ? 'the one waiver' : `the ${countWord(n)} waivers`} on this spec.`;
}

export default function OutcomeSpecPicker({ missionId, workspaceId, selected, readonly }: {
  missionId: string;
  workspaceId: string | null;
  selected: readonly LivingSpecGoalCriterion[];
  readonly?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [specs, setSpecs] = useState<SpecOption[] | null>(null);
  const [specId, setSpecId] = useState('');
  const [revision, setRevision] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [criteria, setCriteria] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState<LivingSpecGoalCriterion | null>(null);

  async function openPicker(prefill?: LivingSpecGoalCriterion) {
    setOpen(true);
    setError(null);
    setChanging(prefill ?? null);
    setSpecId(prefill?.specId ?? '');
    setRevision(prefill ? String(prefill.revision) : '');
    setNarrow(!!prefill?.criteria);
    setCriteria(prefill?.criteria?.join(', ') ?? '');
    setReason(prefill?.narrowedReason ?? '');
    if (specs || !workspaceId) return;
    try {
      const res = await fetch(`/api/specs?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(typeof body.error === 'string' ? body.error : 'Could not load the specs.'); return; }
      setSpecs((body.specs ?? []).filter((s: SpecOption) => s.status !== 'superseded'));
    } catch {
      setError('Could not reach buildd.');
    }
  }

  const body = outcomeSpecBody({ specId, revision, narrow, criteria, reason, current: changing ?? selected.find(c => c.specId === specId) ?? null });
  const warning = repinWarning(body, changing ?? selected.find(c => c.specId === specId) ?? null);

  async function save() {
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcomeSpec: body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(typeof out.error === 'string' ? out.error : 'Could not save. Try again.'); return; }
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach buildd.');
    } finally {
      setSaving(false);
    }
  }

  const options: SelectOption[] = (specs ?? []).map(s => ({ value: s.id, label: s.title, description: specOptionDescription(s) }));

  return (
    <div data-testid="outcome-spec-picker">
      <h3 className="mb-1 text-body font-semibold text-text-primary">Outcome spec</h3>
      {selected.length === 0 ? (
        <p className="text-meta text-text-muted">None. The mission completes on its goal criteria alone.</p>
      ) : (
        <ul className="space-y-1">
          {selected.map(c => (
            <li key={c.specId} className="text-meta text-text-secondary leading-snug">
              <a href={`/app/specs/${c.specId}`} className="underline underline-offset-2">{c.label ?? `Spec revision ${c.revision}`}</a>
              {c.provisional ? ', proposed' : ''}
              {c.criteria ? `. Only ${c.criteria.join(', ')}` : ''}
              {!readonly && !open && (
                <button type="button" className={`${LINK} ml-2`} onClick={() => void openPicker(c)}>Change</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readonly && !open && (
        <button type="button" className={`${LINK} mt-1`} data-testid="outcome-spec-choose" onClick={() => void openPicker()}>
          {selected.length === 0 ? 'Choose an outcome spec' : 'Add another spec'}
        </button>
      )}

      {!readonly && open && (
        <form
          className="mt-2 space-y-2"
          data-testid="outcome-spec-form"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <p className="text-meta text-text-muted leading-snug">The mission completes only when every requirement in scope passes on the integrated result.</p>
          <label className="block text-meta text-text-secondary">
            Spec
            <Select
              className="mt-1"
              value={specId}
              onChange={setSpecId}
              options={options}
              placeholder={specs ? (specs.length ? 'Choose a spec' : 'No specs in this workspace') : 'Loading specs'}
              disabled={!specs || specs.length === 0}
              aria-label="Spec"
              testId="outcome-spec-select"
            />
          </label>
          <label className="block text-meta text-text-secondary">
            Revision
            <input
              inputMode="numeric"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="The approved one"
              className={FIELD}
              data-testid="outcome-spec-revision"
            />
          </label>
          <label className="flex min-h-11 md:min-h-0 items-center gap-2 text-meta text-text-secondary">
            <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} data-testid="outcome-spec-narrow" />
            Only some of its requirements
          </label>
          {narrow && (
            <>
              <label className="block text-meta text-text-secondary">
                Which ones (R-n and AC-n)
                <input value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="R-1, R-2, AC-1" className={FIELD} data-testid="outcome-spec-criteria" />
              </label>
              <label className="block text-meta text-text-secondary">
                Why only these
                <input value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD} data-testid="outcome-spec-reason-narrow" />
              </label>
            </>
          )}
          {warning && <p className="text-meta text-status-warning leading-snug" data-testid="outcome-spec-repin-warning">{warning}</p>}
          <div className="flex items-center gap-3">
            <button type="submit" className={BUTTON} disabled={!body || saving} data-testid="outcome-spec-save">
              {saving ? 'Saving' : 'Use this spec'}
            </button>
            <button type="button" className={LINK} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-1 text-meta text-status-error leading-snug">{error}</p>}
    </div>
  );
}
