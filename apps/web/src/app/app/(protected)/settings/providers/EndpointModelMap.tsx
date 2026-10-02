'use client';

import { useEffect, useRef, useState } from 'react';
import { Select } from '@/components/ui/Select';
import Chip from '@/components/ui/Chip';

/**
 * The agent endpoint editor's model mapping (docs/design/agent-model-endpoint.md
 * §4): one row per model buildd will ask the endpoint for, each with a
 * dropdown of the models the endpoint itself lists.
 *
 * The server reads the endpoint's `/v1/models` (the key never comes to the
 * browser) and prefills every row: the saved alias, else the id as is when
 * listed, else what the team's tier registry already routes that tier to,
 * else the same model under another name. Rows still unmatched are offered to
 * the team's decision model, whose pick is shown flagged and is saved only
 * when the person saves. A row nothing matched stays "send as is", flagged as
 * not served by this endpoint.
 */

export interface EndpointModelRowView {
  model: string;
  tiers: string[];
  value: string | null;
  source: 'alias' | 'listed' | 'registry' | 'equivalent' | null;
  served: boolean | null;
}

/** Select value for "send the id unchanged" (a model id never contains a space). */
const AS_IS = '__as is__';
const DEBOUNCE_MS = 300;

const SOURCE_LABEL: Record<NonNullable<EndpointModelRowView['source']>, string> = {
  alias: 'saved',
  listed: 'listed',
  registry: 'tier registry',
  equivalent: 'same model',
};

type Choice = { value: string | null; by: 'auto' | 'suggested' | 'person'; confidence?: number };

/**
 * `request`: the endpoint as the editor describes it, or null when there is
 * not enough to ask yet. `onMapping`: the aliases the rows say to save, or
 * null when the endpoint gave no list (the editor then offers typed aliases).
 */
export function EndpointModelMap({ teamId, workspaceId, request, disabled, onMapping }: {
  teamId: string;
  workspaceId: string;
  request: Record<string, unknown> | null;
  disabled?: boolean;
  onMapping: (models: Record<string, string> | null) => void;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'none'>('idle');
  const [listed, setListed] = useState<string[]>([]);
  const [rows, setRows] = useState<EndpointModelRowView[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const seq = useRef(0);
  const key = request ? JSON.stringify({ request, workspaceId }) : '';

  useEffect(() => {
    const mine = ++seq.current;
    if (!request) { setState('idle'); onMapping(null); return; }
    const timer = setTimeout(async () => {
      setState('loading');
      try {
        const res = await fetch(`/api/teams/${teamId}/agent-endpoint/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workspaceId ? { ...request, workspaceId } : request),
        });
        const body = res.ok ? await res.json() as { available?: boolean; listed?: string[]; rows?: EndpointModelRowView[] } : null;
        if (mine !== seq.current) return;
        if (!body?.available || !Array.isArray(body.rows) || body.rows.length === 0) {
          setState('none');
          onMapping(null);
          return;
        }
        const list = body.listed ?? [];
        setListed(list);
        setRows(body.rows);
        setChoices(Object.fromEntries(body.rows.map((r) => [r.model, { value: r.value, by: 'auto' as const }])));
        setState('ready');
        const unmatched = body.rows.filter((r) => r.source === null && !r.served).map((r) => r.model);
        if (unmatched.length > 0) void suggest(mine, list, unmatched);
      } catch {
        if (mine === seq.current) { setState('none'); onMapping(null); }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `key` stands for request + workspaceId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, teamId]);

  async function suggest(mine: number, list: string[], models: string[]) {
    try {
      const res = await fetch(`/api/teams/${teamId}/agent-endpoint/models/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workspaceId ? { listed: list, models, workspaceId } : { listed: list, models }),
      });
      if (!res.ok || mine !== seq.current) return;
      const { suggestions } = await res.json() as { suggestions?: Array<{ model: string; suggested: string; confidence: number }> };
      if (mine !== seq.current || !Array.isArray(suggestions)) return;
      setChoices((prev) => {
        const next = { ...prev };
        for (const s of suggestions) {
          // Never over a choice the person made, and only a listed model.
          if (next[s.model]?.by !== 'auto' || next[s.model]?.value !== null || !list.includes(s.suggested)) continue;
          next[s.model] = { value: s.suggested, by: 'suggested', confidence: s.confidence };
        }
        return next;
      });
    } catch {
      // A suggestion is optional: the row stays as it was.
    }
  }

  useEffect(() => {
    if (state !== 'ready') return;
    const models: Record<string, string> = {};
    for (const r of rows) {
      const v = choices[r.model]?.value;
      if (v && v !== r.model) models[r.model] = v;
    }
    onMapping(models);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, rows, choices]);

  if (state === 'idle' || state === 'none') return null;
  if (state === 'loading') return <p className="text-text-muted" data-testid="endpoint-models-loading">Reading the endpoint&apos;s models…</p>;

  const options = [
    { value: AS_IS, label: 'Send as is', description: 'The id buildd asks for, unchanged' },
    ...listed.map((id) => ({ value: id, label: id })),
  ];

  return (
    <div className="space-y-1" data-testid="endpoint-model-map">
      <p className="field-label">Models</p>
      <p className="text-text-muted">Which of this endpoint&apos;s models each buildd model goes to.</p>
      <ul className="border-t border-border-default">
        {rows.map((r) => {
          const c = choices[r.model] ?? { value: null, by: 'auto' as const };
          const sent = c.value ?? r.model;
          const served = listed.includes(sent);
          return (
            <li key={r.model} data-testid="endpoint-model-row" data-model={r.model}
              className="flex flex-col md:flex-row md:items-center gap-2 py-2 border-b border-border-default">
              <div className="md:w-60 min-w-0">
                <p className="font-mono text-text-primary truncate" title={r.model}>{r.model}</p>
                <p className="text-text-muted">{r.tiers.length > 0 ? r.tiers.join(', ') : 'saved alias'}</p>
              </div>
              <Select
                size="sm"
                className="flex-1 min-w-0"
                aria-label={`Endpoint model for ${r.model}`}
                value={c.value ?? AS_IS}
                options={options}
                searchable
                disabled={disabled}
                onChange={(v) => setChoices((prev) => ({ ...prev, [r.model]: { value: v === AS_IS ? null : v, by: 'person' } }))}
              />
              <div className="flex flex-wrap gap-1 md:w-40 md:justify-end">
                {c.by === 'suggested' && (
                  <Chip tone="accent" data-testid="endpoint-model-suggested" title="Picked by the team's decision model. Check it before saving."
                    trailing={c.confidence !== undefined ? `${Math.round(c.confidence * 100)}%` : undefined}>suggested</Chip>
                )}
                {c.by === 'auto' && r.source && r.source !== 'listed' && (
                  <Chip tone="muted" dot={false}>{SOURCE_LABEL[r.source]}</Chip>
                )}
                {!served && <Chip tone="warning" data-testid="endpoint-model-unserved" title="This endpoint does not list it: agents asking for it will be refused.">not served</Chip>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
