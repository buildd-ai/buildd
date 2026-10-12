'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ListProvidersResponse, ProviderAssignmentsResponse, ProviderSurfaceId } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';
import { AUTOMATIC, loneProviderLine, usedForView } from './providers-view';

/**
 * Which connected provider serves each surface. With one provider connected
 * there is nothing to choose: one line says what it is used for. With two or
 * more, one picker per surface (`teams.provider_assignments`, PATCH
 * /api/providers/assignments); an option a surface cannot use is disabled with
 * what it needs. `decisions` is the decision model row (a platform operator's
 * only; absent for everyone else), `extra` the Claude / Codex switch, both
 * drawn only in the table.
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

  const lone = loneProviderLine(data);
  const rows = assignments ? usedForView(data, assignments) : null;

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

  if (!rows) {
    return lone ? <p className="text-body text-text-secondary" data-testid="provider-lone">{lone}</p> : null;
  }

  return (
    <Section title="Used for" id="used-for" className="scroll-mt-20">
      <dl className="border-y border-border-default divide-y divide-border-default" data-testid="used-for">
        {rows.map((r) => (
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
        {decisions && <div className="py-2" data-testid="used-for-decisions">{decisions}</div>}
      </dl>
      {err && <p role="alert" className="text-meta text-status-error mt-2">{err}</p>}
      {extra && <div className="mt-4">{extra}</div>}
    </Section>
  );
}
