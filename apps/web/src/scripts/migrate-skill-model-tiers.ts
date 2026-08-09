#!/usr/bin/env bun
/**
 * One-time migration: upgrade legacy model shorthands to tier values.
 *
 * Maps workspace_skills rows where model is a legacy shorthand to the
 * equivalent tier:
 *   opus   → premium
 *   sonnet → standard
 *   haiku  → budget
 *
 * Usage:
 *   cd apps/web && bun run src/scripts/migrate-skill-model-tiers.ts
 *   cd apps/web && bun run src/scripts/migrate-skill-model-tiers.ts --dry-run
 */

import { resolve } from 'path';

const dryRun = process.argv.includes('--dry-run');

const TIER_MAP: Record<string, string> = {
  opus: 'premium',
  sonnet: 'standard',
  haiku: 'budget',
};

async function loadEnvFile(path: string) {
  const file = Bun.file(path);
  if (await file.exists()) {
    const text = await file.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        let val = trimmed.slice(eqIdx + 1);
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
    return true;
  }
  return false;
}

const monorepoRoot = resolve(import.meta.dir, '../../../..');
const loaded = await loadEnvFile(resolve(monorepoRoot, '.env.local'));
if (!loaded) await loadEnvFile(resolve(monorepoRoot, '.env'));

import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { inArray, eq } from 'drizzle-orm';

async function main() {
  console.log(dryRun ? '\n[dry-run] Skill model tier migration\n' : '\nSkill model tier migration\n');

  const legacyValues = Object.keys(TIER_MAP);

  const rows = await db
    .select({ id: workspaceSkills.id, slug: workspaceSkills.slug, model: workspaceSkills.model })
    .from(workspaceSkills)
    .where(inArray(workspaceSkills.model, legacyValues));

  if (rows.length === 0) {
    console.log('No rows with legacy model shorthands found. Nothing to do.');
    return;
  }

  console.log(`Found ${rows.length} row(s) to migrate:\n`);
  for (const row of rows) {
    const tier = TIER_MAP[row.model];
    console.log(`  ${row.slug} (${row.id}): ${row.model} → ${tier}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] No changes written.');
    return;
  }

  console.log('\nApplying updates...');

  let updated = 0;
  for (const [legacy, tier] of Object.entries(TIER_MAP)) {
    const affected = rows.filter((r) => r.model === legacy);
    if (affected.length === 0) continue;

    await db
      .update(workspaceSkills)
      .set({ model: tier })
      .where(inArray(workspaceSkills.id, affected.map((r) => r.id)));

    updated += affected.length;
    console.log(`  ${legacy} → ${tier}: ${affected.length} row(s) updated`);
  }

  console.log(`\nDone. ${updated} row(s) updated.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
