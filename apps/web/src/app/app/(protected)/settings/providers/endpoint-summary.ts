/**
 * Pure helpers for the agent endpoint section's read view and its editor's
 * starting point. Kept out of the component so they test without a DOM.
 */

export interface MappingRow { model: string; tiers: string[]; sent: string }

/**
 * One line for a mapping table: "5 models → fireworks_ai/x, 1 → claude-haiku-4-5".
 * Models sent unchanged read "sent as is". Biggest group first, then table order.
 */
export function mappingSummary(mapping: readonly MappingRow[] | undefined): string {
  if (!mapping || mapping.length === 0) return '';
  const groups = new Map<string, number>();
  for (const m of mapping) {
    const key = m.sent === m.model ? '' : m.sent;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([sent, n], i) => ({ sent, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ sent, n }, k) => {
      const count = k === 0 ? `${n} model${n === 1 ? '' : 's'}` : `${n}`;
      return sent ? `${count} → ${sent}` : `${count} sent as is`;
    })
    .join(', ');
}

interface EndpointLike {
  scope: 'team' | 'workspace';
  workspaceId: string | null;
  lastVerifiedAt: string | null;
}

/**
 * What a new workspace override starts from, so it is not a page of "send as
 * is" rows: the team endpoint, else the most recently checked override of
 * another workspace (the last listed when none was checked). Null when the
 * team has neither.
 */
export function prefillSource<E extends EndpointLike>(endpoints: readonly E[], workspaceId: string): E | null {
  const team = endpoints.find((e) => e.scope === 'team');
  if (team) return team;
  const siblings = endpoints.filter((e) => e.scope === 'workspace' && e.workspaceId !== workspaceId);
  let best: E | null = null;
  for (const e of siblings) {
    if (!best || (e.lastVerifiedAt ?? '') >= (best.lastVerifiedAt ?? '')) best = e;
  }
  return best;
}
