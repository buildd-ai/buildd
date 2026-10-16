/**
 * Which worker rows a terminal PR fact may reach (docs/specs/workflow-kernel-library.md §1, S4a).
 *
 * For a delivery-owned task, `workers.merged_at` and `workers.pr_lifecycle_status` are the
 * kernel's projection: T17 / T18 write them in the transition's own statement (kernel.ts
 * `w_proj`). Every other caller of the PR fact funnel (`recordPrFact`) is a fact funnel: it
 * records what GitHub said, and for a kernel-owned row the reducer decides. The scope makes that
 * hold in SQL, in the funnel's own WHERE:
 *
 *  - a row whose PR has no kernel-owned delivery (no delivery, released to legacy, or the
 *    workspace's kill switch off) takes the fact as it always has;
 *  - a kernel-owned row takes it only when its delivery already says the same thing (MERGED for
 *    a merge; CLOSED_UNMERGED, SUPERSEDED or ABANDONED for a close). That is the read-through and
 *    sweep heals of a row the transition never saw (a retry that adopted the PR after the merge),
 *    and never a contradiction: a merge fact for an ABANDONED delivery writes nothing (AC-4).
 *
 * The scope brand is minted here and nowhere else in deployed code (the S4a write-site guard).
 */
import { sql, type SQL } from 'drizzle-orm';
import { PR_FACT_SCOPE, type PrFactScope, type TerminalPrFactKind } from '@buildd/core/pr-fact-sql';
import { kernelOnSql } from './kill-switch';

/**
 * The one reading of "this worker row carries that delivery's PR", for both the transition's
 * projection and the funnel's exclusion, so the two can never disagree about a row. `d` is the
 * delivery's alias; the worker row is the funnel's `w`. A delivery owns its own workspace's rows
 * (another workspace on the same repo has its own delivery, or none, and its own writers). The
 * URL is the one `create_pr` and the webhook record.
 */
export function prRowOfDeliverySql(d: string): SQL {
  const a = sql.raw(d);
  // Case folded: GitHub owner and repo names are case-insensitive, so a URL recorded with other
  // casing is still this PR (and is then both projected and excluded, never one without the other).
  return sql`w.workspace_id = ${a}.workspace_id AND w.pr_number = ${a}.pr_number AND lower(w.pr_url) = lower('https://github.com/' || ${a}.repo_full_name || '/pull/' || ${a}.pr_number::text)`;
}

/**
 * The one definition of "delivery-owned" for a worker row `w` (§1): its PR belongs to a delivery
 * the kernel decides for (authority kernel, the workspace's kill switch on). A delivery released
 * to legacy, or a workspace with the kernel off, is not delivery-owned: legacy writers keep it.
 * `extra` narrows the delivery (the funnel's "does it already agree" test).
 */
export function kernelOwnedRowSql(extra?: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw ON kw.id = kd.workspace_id
    WHERE kd.authority = 'kernel' AND ${kernelOnSql(sql`kw.git_config`)} AND ${prRowOfDeliverySql('kd')}${extra ? sql` AND ${extra}` : sql``})`;
}

/** The delivery states a terminal fact agrees with: the funnel may write only what these already say. */
const AGREES: Record<TerminalPrFactKind, string[]> = {
  merged: ['MERGED'],
  closed: ['CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED'],
};

/** The scope every funnel caller outside the kernel passes with a terminal fact. */
export const factFunnelScope: PrFactScope = {
  [PR_FACT_SCOPE]: 'fact_funnel',
  where: (kind) => sql`NOT ${kernelOwnedRowSql(sql`kd.state NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(AGREES[kind])}::jsonb))`)}`,
};

/** The kernel's own projection (`stamp_pr_rows`, the backstop of the transition's): it is the writer. */
export const kernelProjectionScope: PrFactScope = { [PR_FACT_SCOPE]: 'kernel_projection', where: () => null };
