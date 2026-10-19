/**
 * The headline Health prints over a stranded-backend row (spec 97b1bd0b R-10).
 *
 * "Has no credential" / "unclaimable" is the claim scheduler's verdict, so it is
 * only said when a sampled task carries a fresh recorded refusal for a missing
 * credential. A configured-credential lookup alone, or a stale/unknown decision,
 * yields an unconfirmed headline that says what is and is not known.
 *
 * Pure and DB-free: imported by a client component.
 */
import type { ClaimBlocker } from './claim-blocker-projection';

interface StrandRowLike {
  label: string;
  strandedPending: number;
  sampleTasks: ReadonlyArray<{ claim?: Pick<ClaimBlocker, 'state' | 'kind'> }>;
}

export interface StrandHeadline {
  /** The scheduler has recently refused work on this backend for a credential. */
  confirmed: boolean;
  title: string;
  tag: string;
  detail: string;
}

const plural = (n: number) => `task${n === 1 ? '' : 's'}`;

export function strandHeadline(row: StrandRowLike): StrandHeadline {
  const n = row.strandedPending;
  const claims = row.sampleTasks.map((t) => t.claim);
  const confirmed = claims.some((c) => c?.state === 'blocked' && c.kind === 'credential_unavailable');
  if (confirmed) {
    return {
      confirmed,
      title: `${row.label} has no credential`,
      tag: `${n} ${plural(n)} unclaimable`,
      detail: `Pending work routes to ${row.label}, and the claim scheduler recently refused it for a missing credential`,
    };
  }
  const stale = claims.some((c) => c?.state === 'stale');
  const why = stale
    ? 'the newest scheduler decision is stale'
    : 'the claim scheduler has no recent decision on record';
  return {
    confirmed,
    title: `${row.label}: no team-wide credential found`,
    tag: `${n} pending ${plural(n)}, not confirmed blocked`,
    detail: `Pending work routes to ${row.label} and no credential was found, but ${why}, so a block is not confirmed`,
  };
}
