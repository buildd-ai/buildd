#!/usr/bin/env bun
/**
 * Backfill the default roles' routing text (docs/design/role-routing.md §2)
 * onto seeded role rows that predate it. Seeding is onConflictDoNothing, so an
 * existing team never picks up a change to apps/web/src/lib/default-roles.ts.
 *
 *   DATABASE_URL=... bun run scripts/backfill-role-routing.ts --dry-run
 *   DATABASE_URL=... bun run scripts/backfill-role-routing.ts
 *
 * Only `source = 'system'` rows of a default slug whose metadata has no
 * `routing` key. Never overwrites routing text or an opt-out; idempotent.
 * Run it deliberately — it is not wired to deploy.
 */
// Everything DB-shaped comes through the app module: the repo root does not
// depend on drizzle-orm, apps/web does.
import { backfillDefaultRoleRouting } from '../apps/web/src/lib/default-roles';

const dryRun = process.argv.includes('--dry-run');
const rows = await backfillDefaultRoleRouting({ dryRun });
const bySlug = new Map<string, number>();
for (const r of rows) bySlug.set(r.slug, (bySlug.get(r.slug) ?? 0) + 1);
console.log(`${dryRun ? 'would update' : 'updated'} ${rows.length} role row(s)`, JSON.stringify(Object.fromEntries(bySlug)));
process.exit(0);
