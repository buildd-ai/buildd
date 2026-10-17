#!/usr/bin/env bun
/**
 * Backfill Living Spec criterion records and kept reviews (spec aafdec35
 * "Reviewing a spec revision", R-8, R-11) for revisions written before they
 * were kept: one spec_criteria row per R-n/AC-n of each revision, derived from
 * its body, and the spec_revision_reviews Review reads.
 *
 *   DATABASE_URL=... bun run scripts/backfill-spec-criteria.ts --dry-run
 *   DATABASE_URL=... bun run scripts/backfill-spec-criteria.ts
 *
 * Idempotent: a second run writes nothing. Reads derive whatever is missing on
 * first need anyway, so this only saves that first read its work. Run it
 * deliberately; it is not wired to deploy.
 */
// Everything DB-shaped comes through the app module: the repo root does not
// depend on drizzle-orm, apps/web does.
import { backfillSpecCriteria } from '../apps/web/src/lib/specs/review';

const dryRun = process.argv.includes('--dry-run');
const r = await backfillSpecCriteria({ dryRun });
console.log(`${dryRun ? 'would derive' : 'derived'} ${r.revisions} revision(s) and ${dryRun ? 'would keep' : 'kept'} ${r.reviews} review(s) across ${r.specs} spec(s)${r.failed.length ? `; ${r.failed.length} spec(s) failed` : ''}`);
process.exit(r.failed.length ? 1 : 0);
