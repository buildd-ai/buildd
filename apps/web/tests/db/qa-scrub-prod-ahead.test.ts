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
 * The scrub walks every row of every table, so it runs in a scratch database
 * migrated from this checkout and holding only what this file seeds: what other
 * test files leave in the shared database (a 300x slowdown once) can't reach it.
 *
 * Each run swaps the script's COMMIT for checks plus a ROLLBACK: the test
 * database is left as it was, and what the scrub did is asserted from inside
 * its own transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { assertDbConfigured, withDb } from './harness';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRUB = readFileSync(join(ROOT, 'scripts/qa/scrub-pii.sql'), 'utf8');
const { knownColumns, latestSnapshotPath, schemaShape } = await import('../../../../scripts/qa/known-columns');
// -v shape, as visual-qa.yml passes it: this checkout's schema (`known-columns.ts --shape`).
const SHAPE = JSON.stringify(schemaShape(JSON.parse(readFileSync(latestSnapshotPath(join(ROOT, 'packages/core/drizzle')), 'utf8'))));

// Matches nothing a seeded row holds; the scrub refuses an empty pattern.
const IDS = 'qa-scrub-test-never-matches';
const SCRUB_TIMEOUT_MS = 120_000;

const CORE = join(ROOT, 'packages', 'core');
const BASE_URL = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/x');
const SCRATCH = `qa_scrub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const scratchUrl = () => {
  const u = new URL(BASE_URL.toString());
  u.pathname = `/${SCRATCH}`;
  return u.toString();
};
async function admin(sqlText: string) {
  const c = new pg.Client({ connectionString: BASE_URL.toString() });
  await c.connect();
  try {
    await c.query(sqlText);
  } finally {
    await c.end();
  }
}

/** Run a variant of the scrub; `checks` replaces COMMIT and must end in ROLLBACK. */
function runScrub(opts: { script: string; known: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-scrub-'));
  const file = join(dir, 'scrub.sql');
  writeFileSync(file, opts.script);
  try {
    return spawnSync('psql', [
      scratchUrl(), '-X', '-q',
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
  await admin(`CREATE DATABASE ${SCRATCH}`);
  const m = spawnSync('bun', ['db/migrate.ts'], {
    cwd: CORE, encoding: 'utf8', timeout: 10 * 60_000,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
  });
  if (m.status !== 0) throw new Error(`scratch migrate failed (${m.status}):\n${`${m.stdout}\n${m.stderr}`.slice(-3000)}`);
  // A body makes revision 1, the row the immutability trigger guards.
  await withDb(scratchUrl(), async (c) => {
    const { rows: [team] } = await c.query(`INSERT INTO teams (name, slug) VALUES ('qa-scrub', 'qa-scrub') RETURNING id`);
    const { rows: [ws] } = await c.query(`INSERT INTO workspaces (name, team_id) VALUES ('qa-scrub', $1) RETURNING id`, [team.id]);
    await c.query(`INSERT INTO artifacts (workspace_id, type, title, content)
      VALUES ($1, 'content', 'qa scrub', 'a body only the scrub may touch')`, [ws.id]);
  });
}, 12 * 60_000);

afterAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
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

describe('scrub-pii.sql when trunk is ahead of prod', () => {
  // The harness comes from trunk, the clone from prod. A trigger an unreleased
  // trunk migration creates is absent from the clone, and $shim$ adds columns,
  // not triggers. Naming that trigger in a bare ALTER TABLE failed the scrub
  // ("trigger spec_revisions_explanation_immutable ... does not exist").
  test('a column trunk added with its immutability trigger, neither in prod yet, still scrubs', () => {
    const setup = `
      DROP TRIGGER spec_revisions_explanation_immutable ON spec_revisions;
      ALTER TABLE spec_revisions DROP COLUMN explanation;`;
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, `DO $t$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'spec_revisions_explanation_immutable') THEN
          RAISE EXCEPTION 'check: the scrub created a trigger the clone did not have';
        END IF;
      END $t$;`, setup),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);

  test('a column prod has without the trigger trunk later put on it still scrubs', () => {
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, 'SELECT 1;', 'DROP TRIGGER spec_revisions_explanation_immutable ON spec_revisions;'),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);

  test('a named trigger prod keeps disabled stays disabled', () => {
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, `DO $t$ BEGIN
        IF ${enabledTriggers('spec_revisions')} NOT LIKE '%spec_revisions_explanation_immutable:D%' THEN
          RAISE EXCEPTION 'check: trigger states changed: %', ${enabledTriggers('spec_revisions')};
        END IF;
      END $t$;`, 'ALTER TABLE spec_revisions DISABLE TRIGGER spec_revisions_explanation_immutable;'),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);

  test('this checkout re-enables the named trigger after the overwrite', () => {
    const r = runScrub({
      known: knownColumns(),
      script: withChecks(SCRUB, `DO $t$ BEGIN
        IF ${enabledTriggers('spec_revisions')} NOT LIKE '%spec_revisions_explanation_immutable:O%' THEN
          RAISE EXCEPTION 'check: trigger was not re-enabled: %', ${enabledTriggers('spec_revisions')};
        END IF;
      END $t$;`),
    });
    expect(r.stderr).not.toContain('ERROR');
    expect(r.status).toBe(0);
  }, SCRUB_TIMEOUT_MS);
});
