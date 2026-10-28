/**
 * Approve all on the Review all page (Living Spec b7fc9316 R-24 to R-26).
 *
 * It is many approvals made in one click, never one approval over many
 * (R-6): each listed revision carries its own signed request, pinned to its
 * spec, revision, version and content hash as the page rendered them, and is
 * confirmed with its own call to the confirm endpoint, which re-checks the
 * pin, the person's rights and the quality gate. A revision that moved is
 * stale and is not approved; the others still are. Pure: the caller supplies
 * how one request is confirmed (a fetch from the page, a stub in tests).
 */

export interface ApproveAllItem {
  specId: string;
  title: string;
  revision: number;
  /** The signed request for exactly this revision (approval-request.ts). */
  request: string;
}

/** The confirm endpoint's reply, as status and JSON body. */
export interface ConfirmReply {
  status: number;
  body: { code?: string; error?: string; currentVersion?: number; headRevision?: number; already?: boolean };
}

export type ApproveAllOutcome =
  | { item: ApproveAllItem; outcome: 'approved' }
  | { item: ApproveAllItem; outcome: 'stale'; headRevision: number | null }
  | { item: ApproveAllItem; outcome: 'needs_reason' | 'needs_passkey' | 'failed'; error: string };

export interface ApproveAllResult {
  outcomes: ApproveAllOutcome[];
  approved: number;
  stale: number;
  /** Not approved for another reason: a gate refusal, a passkey, an error. */
  other: number;
}

const STALE = new Set(['request_stale', 'stale']);

function outcomeOf(item: ApproveAllItem, r: ConfirmReply): ApproveAllOutcome {
  if (r.status >= 200 && r.status < 300) return { item, outcome: 'approved' };
  const code = r.body.code ?? '';
  if (r.status === 409 && STALE.has(code)) return { item, outcome: 'stale', headRevision: typeof r.body.headRevision === 'number' ? r.body.headRevision : null };
  if (code === 'gate_refused') return { item, outcome: 'needs_reason', error: r.body.error ?? 'The quality gate refuses it.' };
  if (code === 'presence_required') return { item, outcome: 'needs_passkey', error: r.body.error ?? 'Your team requires a passkey.' };
  return { item, outcome: 'failed', error: r.body.error ?? `Refused (${r.status}).` };
}

/** Confirm every item, one request each, in order; one failure never stops the rest. */
export async function approveAll(items: readonly ApproveAllItem[], send: (item: ApproveAllItem) => Promise<ConfirmReply>): Promise<ApproveAllResult> {
  const outcomes: ApproveAllOutcome[] = [];
  for (const item of items) {
    try {
      outcomes.push(outcomeOf(item, await send(item)));
    } catch (err) {
      outcomes.push({ item, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
  const approved = outcomes.filter((o) => o.outcome === 'approved').length;
  const stale = outcomes.filter((o) => o.outcome === 'stale').length;
  return { outcomes, approved, stale, other: outcomes.length - approved - stale };
}

/** The result in one paragraph: how many of each, then each one not approved, by name. */
export function approveAllSummary(r: ApproveAllResult): string {
  const counts = [`${r.approved} approved`, ...(r.stale ? [`${r.stale} stale`] : []), ...(r.other ? [`${r.other} not approved`] : [])].join(', ');
  const lines = r.outcomes.flatMap((o): string[] => {
    switch (o.outcome) {
      case 'approved': return [];
      case 'stale': return [`${o.item.title} changed since this page loaded${o.headRevision ? ` (now at revision ${o.headRevision})` : ''}: read it again before approving.`];
      case 'needs_reason': return [`${o.item.title} needs an override reason: the quality gate refuses it, so approve it on its own.`];
      case 'needs_passkey': return [`${o.item.title} needs your passkey: approve it on its own.`];
      case 'failed': return [`${o.item.title} could not be approved: ${o.error}`];
    }
  });
  return [`${counts}.`, ...lines].join(' ');
}
