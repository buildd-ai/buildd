/**
 * scripts/qa/scrub-pii.sql against real Postgres and the real trigger set,
 * through psql exactly as visual-qa.yml runs it.
 *
 * The Visual QA clone is prod's schema plus the dispatched branch's migrations,
 * but the scrub comes from that branch. A branch cut before a table reached
 * prod has no decision for it, so the "prod ahead of this checkout" block
 * overwrites its text columns with a plain UPDATE, and that UPDATE runs every
 * trigger prod has on the table. artifact_revisions refuses any UPDATE
 * (migration *_artifact_revisions_trigger), so a branch that predated it
 * failed the scrub, the clone never booted and every capture failed.
 *
 * Each run swaps the script's COMMIT for checks plus a ROLLBACK: the test
 * database is left as it was, and what the scrub did is asserted from inside
 * its own transaction.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRUB = readFileSync(join(ROOT, 'scripts/qa/scrub-pii.sql'), 'utf8');
const { knownColumns, latestSnapshotPath, schemaShape } = await import('../../../../scripts/qa/known-columns');
// -v shape, as visual-qa.yml passes it: this checkout's schema (`known-columns.ts --shape`).
const SHAPE = JSON.stringify(schemaShape(JSON.parse(readFileSync(latestSnapshotPath(join(ROOT, 'packages/core/drizzle')), 'utf8'))));

// Matches nothing a seeded row holds; the scrub refuses an empty pattern.
const IDS = 'qa-scrub-test-never-matches';
// The whole scrub runs per test, over whatever earlier files left in the database.
const SCRUB_TIMEOUT_MS = 120_000;

/** Run a variant of the scrub; `checks` replaces COMMIT and must end in ROLLBACK. */
function runScrub(opts: { script: string; known: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-scrub-'));
  const file = join(dir, 'scrub.sql');
  writeFileSync(file, opts.script);
  try {
    return spawnSync('psql', [
      process.env.DATABASE_URL!, '-X', '-q',
      '-v', 'ON_ERROR_STOP=1', '-v', `ids=${IDS}`, '-v', `known=${opts.known.join(',')}`,
      '-v', `shape=${SHAPE}`, '-f', file,
    ], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withChecks(script: string, checks: string, setup = ''): string {
  expect(script).toContain('\nBEGIN;\n');
  expect(script).toContain('\nCOMMIT;\n');
  return script
    .replace('\nBEGIN;\n', `\nBEGIN;\n${setup}\n`)
    .replace('\nCOMMIT;\n', `\n${checks}\nROLLBACK;\n`);
}

/** The checkout a lagging branch would have: no artifact_revisions anywhere. */
const preRevisionsScript = () => SCRUB.replace(/^DELETE FROM artifact_revisions;.*$/m, '');
const preRevisionsKnown = () => knownColumns().filter((c) => !c.startsWith('artifact_revisions.'));

const enabledTriggers = (table: string) => `
  (SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
   WHERE tgrelid = 'public.${table}'::regclass AND NOT tgisinternal)`;

beforeAll(async () => {
  assertDbConfigured();
  const which = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  if (which.status !== 0) throw new Error('psql is required: the scrub is a psql script (meta-commands, -v vars)');
  const { workspaceId } = await seedWorkspace();
  // A body makes revision 1, the row the immutability trigger guards.
  await q(sql`INSERT INTO artifacts (workspace_id, type, title, content)
    VALUES (${workspaceId}::uuid, 'content', 'qa scrub', 'a body only the scrub may touch')`);
});

describe('scrub-pii.sql under the artifact revision triggers', () => {
  test('this checkout scrubs and keeps no body history', () => {
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, `DO $t$ BEGIN
        IF EXISTS (SELECT 1 FROM artifact_revisions) THEN RAISE EXCEPTION 'check: body history survived'; END IF;
      END $t$;`),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);

  test('a branch cut before artifact_revisions existed still scrubs (the Visual QA regression)', () => {
    const r = runScrub({
      known: preRevisionsKnown(),
      script: withChecks(preRevisionsScript(), `DO $t$ BEGIN
        IF EXISTS (SELECT 1 FROM artifact_revisions WHERE content IS NOT NULL OR author IS NOT NULL) THEN
          RAISE EXCEPTION 'check: an unknown history column kept its text';
        END IF;
        IF ${enabledTriggers('artifact_revisions')} IS DISTINCT FROM 'artifact_revisions_immutable:O' THEN
          RAISE EXCEPTION 'check: the immutability trigger was not re-enabled';
        END IF;
        IF ${enabledTriggers('artifacts')} IS DISTINCT FROM 'artifacts_record_first_revision:O,artifacts_record_revision:O' THEN
          RAISE EXCEPTION 'check: the revision triggers were not re-enabled';
        END IF;
      END $t$;`),
    });
    expect(r.stderr).not.toContain('artifact_revisions rows are immutable');
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);

  test('any table prod has and this checkout does not is overwritten past its UPDATE triggers, which stay as they were', () => {
    // Prod ahead of the branch by one append-only table: an immutability trigger
    // like artifact_revisions', and a second trigger prod keeps disabled.
    const setup = `
      CREATE TABLE qa_prod_ahead_history (id serial PRIMARY KEY, body text, note text NOT NULL);
      INSERT INTO qa_prod_ahead_history (body, note) VALUES ('tenant prose', 'tenant note');
      CREATE FUNCTION pg_temp.qa_refuse() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN RAISE EXCEPTION 'qa_prod_ahead_history rows are immutable'; END $f$;
      CREATE TRIGGER qa_prod_ahead_immutable BEFORE UPDATE ON qa_prod_ahead_history
        FOR EACH ROW EXECUTE FUNCTION pg_temp.qa_refuse();
      CREATE TRIGGER qa_prod_ahead_off BEFORE UPDATE ON qa_prod_ahead_history
        FOR EACH ROW EXECUTE FUNCTION pg_temp.qa_refuse();
      ALTER TABLE qa_prod_ahead_history DISABLE TRIGGER qa_prod_ahead_off;`;
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, `DO $t$ BEGIN
        IF EXISTS (SELECT 1 FROM qa_prod_ahead_history WHERE body IS NOT NULL OR note LIKE 'tenant%') THEN
          RAISE EXCEPTION 'check: an unknown column kept its text';
        END IF;
        IF ${enabledTriggers('qa_prod_ahead_history')} IS DISTINCT FROM 'qa_prod_ahead_immutable:O,qa_prod_ahead_off:D' THEN
          RAISE EXCEPTION 'check: trigger states changed: %', ${enabledTriggers('qa_prod_ahead_history')};
        END IF;
      END $t$;`, setup),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);
});
