/**
 * Landing ownership as a read model: who owns the next move on a PR the
 * platform is landing, derived from the same marker (`tasks.context.landing`),
 * merge policy and landing mode the landing function itself uses.
 *
 * Under an agent-review `approve-and-merge` policy with `landing.mode=enforce`
 * a clean approved PR is the platform's to land: it is refreshed from its base,
 * re-checked, re-reviewed and merged without a person in the loop. Home must
 * never render a human MERGE card for it from a transient approved+green
 * snapshot. The one thing that hands it to a person is landPr itself returning
 * `needs_human`, which `recordLandingHandoff` persists (`tasks.context.landingHandoff`)
 * bound to the head it was decided for. A new head, such as the one a base
 * refresh produces, invalidates that record by construction.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
export * from './pr-landing-ownership';
import type { LandingHandoff } from './pr-landing-ownership';

/** Persist a handoff for the head it was decided on. One atomic UPDATE. */
export async function writeLandingHandoff(taskId: string, handoff: LandingHandoff): Promise<void> {
  const json = JSON.stringify({ ...handoff, at: new Date().toISOString() });
  await db
    .update(tasks)
    .set({ context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landingHandoff}', ${json}::jsonb, true)` })
    .where(eq(tasks.id, taskId));
}

/** Drop a stale handoff; a no-op write is skipped by the WHERE. */
export async function clearLandingHandoff(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ context: sql`${tasks.context} - 'landingHandoff'` })
    .where(and(eq(tasks.id, taskId), sql`${tasks.context} ? 'landingHandoff'`));
}
