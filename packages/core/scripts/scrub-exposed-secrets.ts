/**
 * One-time incident cleanup for plaintext values rotated after the Cue incidents.
 *
 * Usage:
 *   DATABASE_URL=... INCIDENT_CUE_SECRET=... INCIDENT_DISPATCH_API_KEY=... \
 *     bun packages/core/scripts/scrub-exposed-secrets.ts
 *
 * Safe to rerun: replacements are idempotent and the secret values are never logged.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';

const values = [
  { label: 'CUE_SECRET', value: process.env.INCIDENT_CUE_SECRET },
  { label: 'DISPATCH_API_KEY', value: process.env.INCIDENT_DISPATCH_API_KEY },
].filter((item): item is { label: string; value: string } =>
  typeof item.value === 'string' && item.value.length >= 8,
);

if (values.length === 0) {
  throw new Error('Set INCIDENT_CUE_SECRET and/or INCIDENT_DISPATCH_API_KEY');
}

for (const { label, value } of values) {
  const replacement = `[REDACTED:${label}]`;

  await db.execute(sql`
    UPDATE workers SET
      error = replace(error, ${value}, ${replacement}),
      current_action = replace(current_action, ${value}, ${replacement}),
      milestones = CASE WHEN milestones IS NULL THEN NULL
        ELSE replace(milestones::text, ${value}, ${replacement})::jsonb END,
      waiting_for = CASE WHEN waiting_for IS NULL THEN NULL
        ELSE replace(waiting_for::text, ${value}, ${replacement})::jsonb END,
      instruction_history = CASE WHEN instruction_history IS NULL THEN NULL
        ELSE replace(instruction_history::text, ${value}, ${replacement})::jsonb END,
      result_meta = CASE WHEN result_meta IS NULL THEN NULL
        ELSE replace(result_meta::text, ${value}, ${replacement})::jsonb END
    WHERE concat_ws(' ', error, current_action, milestones::text, waiting_for::text,
      instruction_history::text, result_meta::text) LIKE ${`%${value}%`}
  `);

  await db.execute(sql`
    UPDATE worker_error_traces
    SET excerpt = replace(excerpt, ${value}, ${replacement})
    WHERE excerpt LIKE ${`%${value}%`}
  `);

  await db.execute(sql`
    UPDATE tasks
    SET result = replace(result::text, ${value}, ${replacement})::jsonb
    WHERE result::text LIKE ${`%${value}%`}
  `);

  await db.execute(sql`
    UPDATE artifacts
    SET content = replace(content, ${value}, ${replacement})
    WHERE content LIKE ${`%${value}%`}
  `);
}

console.log(`Scrubbed ${values.length} rotated incident secret value(s).`);
