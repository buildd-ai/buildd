import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * scrub-pii.sql rewrites a prod clone before Visual QA screenshots it, and the
 * screenshots land in an artifact anyone can download (public repo). The
 * invariant: CI QA screenshots contain no tenant-identifying text.
 *
 * This pins coverage against the schema, not against memory: every
 * text/varchar/json(b) column of every table in packages/core/db/schema.ts must
 * be (a) assigned in an UPDATE in scrub-pii.sql, (b) in a table the file
 * DELETEs or TRUNCATEs, or (c) listed below as structurally safe. A string-
 * literal-union `.$type<'a' | 'b'>()` column is an enum and counts as (c).
 * Adding a column without a decision fails here.
 */

const root = join(__dirname, '..', '..');
const schemaSrc = readFileSync(join(root, 'packages/core/db/schema.ts'), 'utf8');
const sqlSrc = readFileSync(join(__dirname, 'scrub-pii.sql'), 'utf8');

interface Col { table: string; column: string; enumTyped: boolean }

function schemaTextColumns(src: string): { tables: string[]; cols: Col[] } {
  const starts = [...src.matchAll(/pgTable\(\s*'([a-z_0-9]+)'/g)].map(m => ({ table: m[1], at: m.index! }));
  const cols: Col[] = [];
  starts.forEach((s, i) => {
    const body = src.slice(s.at, starts[i + 1]?.at ?? src.length);
    // Only the column block, not the index/constraint callback after it.
    for (const line of body.split('\n')) {
      const m = /^\s+\w+:\s*(?:text|varchar|jsonb|json)\(\s*'([a-z_0-9]+)'/.exec(line);
      if (!m) continue;
      const typeArg = /\.\$type<([^>]*)>/.exec(line)?.[1]?.trim() ?? '';
      const enumTyped = typeArg !== '' && /^('[^']*'|null)(\s*\|\s*('[^']*'|null))*$/.test(typeArg);
      cols.push({ table: s.table, column: m[1], enumTyped });
    }
  });
  return { tables: starts.map(s => s.table), cols };
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Split a SET clause on top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function sqlCoverage(sql: string) {
  const body = stripComments(sql);
  // Only statements outside function bodies ($f$ … $f$).
  const top = body.replace(/\$f\$[\s\S]*?\$f\$/g, '');
  const assigned = new Map<string, Set<string>>();
  for (const m of top.matchAll(/\bUPDATE\s+([a-z_0-9]+)(?:\s+(?!SET\b)[a-z_0-9]+)?\s+SET\s+([\s\S]*?)(?=\bFROM\b|\bWHERE\b|;)/gi)) {
    const table = m[1];
    const set = assigned.get(table) ?? new Set<string>();
    for (const part of splitTopLevel(m[2])) {
      const col = /^\s*([a-z_0-9]+)\s*=/.exec(part)?.[1];
      if (col) set.add(col);
    }
    assigned.set(table, set);
  }
  const wiped = new Set<string>();
  for (const m of top.matchAll(/\bDELETE\s+FROM\s+([a-z_0-9]+)/gi)) wiped.add(m[1]);
  for (const m of top.matchAll(/\bTRUNCATE\s+([a-z_0-9,\s]+?);/gi)) {
    for (const t of m[1].split(',')) wiped.add(t.trim());
  }
  return { assigned, wiped, top };
}

// Structurally safe: ids, hashes, shas, enums without a literal $type, model
// ids, timestamps-as-text, cron/timezone, colours, counts, numeric/uuid json.
// Each entry is a decision; keep the reason next to anything non-obvious.
const SAFE: Record<string, string[]> = {
  teams: ['timezone', 'monthly_cost_month', 'budget_alerts_sent', 'enabled_inference_capabilities'],
  team_members: [],
  users: ['timezone'],
  accounts: ['monthly_cost_month', 'budget_alerts_sent'],
  missions: ['context_artifact_ids', 'last_notified_sha', 'criteria_rearm_fingerprint'],
  initiatives: ['context_artifact_ids'],
  tasks: [
    'status', 'required_capabilities', 'heartbeat_tick_anchor', 'ci_retry_head_sha',
    'conflict_retry_head_sha', 'reviewer_retry_head_sha', 'depends_on', 'predicted_model',
    'loop_state', 'subject_head_sha',
  ],
  task_subject_reports: ['origin'],
  task_subject_claims: ['key_type', 'key_hash'],
  workers: ['status', 'pr_opened_base_sha', 'last_commit_sha'],
  worker_action_events: ['action'],
  worker_prompt_composition_events: ['policy_version', 'backend', 'sections'],
  artifacts: ['type'],
  mission_notes: ['delivered_to'],
  worker_heartbeats: ['workspace_ids', 'runner_commit', 'runner_version'],
  task_schedules: ['cron_expression', 'timezone', 'last_heartbeat_state_hash'],
  github_installations: ['permissions'],
  github_repos: ['default_branch'],
  workspace_skills: ['content_hash', 'model', 'color', 'config_hash', 'config_storage_key'],
  task_outcomes: ['kind', 'complexity', 'classified_by', 'predicted_model', 'actual_model', 'total_cost_usd', 'exit_cause'],
  experiment_assignments: ['default_model', 'assigned_model', 'runner_cli_version'],
  tenant_budgets: ['tenant_id'],
  model_tier_registry: ['model'],
  change_intents: ['head_sha'],
  dark_check_alerts: ['check_name'],
  releases: ['head_sha', 'previous_sha', 'version'],
  release_tasks: ['commit_sha'],
  worker_terminal_records: ['exit_cause', 'summary_provenance'],
  migration_log: ['phase'], // multi-line literal-union $type
  credential_leases: ['held_by_runner_id'], // wiped via secrets cascade too
  user_feedback: ['entity_id'],
};

const schema = schemaTextColumns(schemaSrc);
const cov = sqlCoverage(sqlSrc);

describe('scrub-pii.sql covers the schema', () => {
  test('the schema parser sees the tables it must (guards against a silent empty set)', () => {
    for (const t of ['teams', 'accounts', 'workspaces', 'github_repos', 'missions', 'initiatives', 'tasks',
      'workers', 'mission_notes', 'artifacts', 'workspace_skills', 'task_schedules', 'releases', 'memories']) {
      expect(schema.tables).toContain(t);
    }
    expect(schema.cols.length).toBeGreaterThan(200);
    expect(cov.assigned.get('tasks')?.has('title')).toBe(true);
  });

  test('every text/varchar/json column is scrubbed, wiped, or explicitly safe', () => {
    const unscrubbed = schema.cols
      .filter(c => !cov.wiped.has(c.table))
      .filter(c => !cov.assigned.get(c.table)?.has(c.column))
      .filter(c => !c.enumTyped)
      .filter(c => !(SAFE[c.table] ?? []).includes(c.column))
      .map(c => `${c.table}.${c.column}`);
    expect(unscrubbed).toEqual([]);
  });

  test('the allowlist has no stale entries', () => {
    const exists = new Set(schema.cols.map(c => `${c.table}.${c.column}`));
    const stale = Object.entries(SAFE).flatMap(([t, cs]) => cs.map(c => `${t}.${c}`)).filter(k => !exists.has(k));
    expect(stale).toEqual([]);
  });

  test('every table the SQL touches exists in the schema', () => {
    const touched = [...cov.assigned.keys(), ...cov.wiped];
    expect(touched.filter(t => !schema.tables.includes(t))).toEqual([]);
  });

  test('the columns the task names are rewritten, not allowlisted', () => {
    const must: Record<string, string[]> = {
      teams: ['name', 'slug'],
      accounts: ['name', 'github_id'],
      users: ['email', 'name', 'image', 'github_id', 'google_id'],
      team_invitations: ['email'],
      workspaces: ['name', 'repo', 'local_path', 'memory', 'projects'],
      github_repos: ['full_name', 'name', 'owner', 'html_url', 'description'],
      github_installations: ['account_login'],
      missions: ['title', 'description', 'working_branch', 'primary_pr_url', 'goal_criteria'],
      initiatives: ['title', 'description', 'kpis'],
      tasks: ['title', 'description', 'context', 'result', 'external_url', 'subject_branch'],
      workers: ['branch', 'pr_url', 'current_action', 'waiting_for', 'error', 'milestones', 'result_meta', 'runner'],
      mission_notes: ['title', 'body'],
      artifacts: ['title', 'content', 'metadata', 'share_token'],
      workspace_skills: ['name', 'slug', 'content', 'description'],
      task_schedules: ['name', 'task_template', 'last_error'],
      releases: ['run_url', 'deploy_url', 'failure_reason'],
      memories: ['title', 'content', 'tags', 'files'],
    };
    const missing = Object.entries(must).flatMap(([t, cs]) =>
      cs.filter(c => !cov.assigned.get(t)?.has(c)).map(c => `${t}.${c}`));
    expect(missing).toEqual([]);
    for (const t of ['secrets', 'device_codes', 'oauth_codes', 'oauth_refresh_tokens', 'knowledge_chunks']) {
      expect(cov.wiped.has(t)).toBe(true);
    }
  });

  test('plain statements only: no transaction block, fail on first error, quiet', () => {
    expect(cov.top).not.toMatch(/\bBEGIN\s*;|\bCOMMIT\b|\bROLLBACK\b/i);
    expect(sqlSrc).toContain('\\set ON_ERROR_STOP on');
    expect(sqlSrc).toContain('\\set QUIET on');
  });

  test('known identifiers are redacted from kept tokens, jsonb keys and tool lists', () => {
    expect(sqlSrc).toContain("SET qa.ids = :'ids';");
    // Fails closed on an empty pattern, and speaks Postgres word boundaries.
    expect(sqlSrc).toMatch(/IF pg_temp\.qa_ids\(\) IS NULL THEN\s+RAISE EXCEPTION/);
    expect(sqlSrc).toContain("'\\b', '\\y'");
    // Checked before any keep-as-is rule in qa_str, and on object keys.
    const qaStr = /FUNCTION pg_temp\.qa_str[\s\S]*?\$f\$;/.exec(sqlSrc)![0];
    expect(qaStr.indexOf('qa_is_ident')).toBeGreaterThan(-1);
    expect(qaStr.indexOf('qa_is_ident')).toBeLessThan(qaStr.indexOf('THEN s'));
    expect(sqlSrc).toMatch(/jsonb_object_agg\(pg_temp\.qa_key\(k\)/);
    expect(cov.assigned.get('workspace_skills')?.has('allowed_tools')).toBe(true);
  });

  test('the CI QA user is designated before the general user scrub', () => {
    const designate = sqlSrc.indexOf("email = 'ci-qa@buildd.dev'");
    const general = sqlSrc.indexOf("'@scrubbed.local'");
    expect(designate).toBeGreaterThan(-1);
    expect(general).toBeGreaterThan(designate);
  });
});

describe('scrub-guard.sql', () => {
  const guard = readFileSync(join(__dirname, 'scrub-guard.sql'), 'utf8');

  test('takes the pattern from psql -v ids, fails closed when unset/empty', () => {
    expect(guard).toContain("SET qa.ids = :'ids';");
    expect(guard).toContain('\\set ON_ERROR_STOP on');
    expect(guard).toMatch(/IF ids = '' THEN\s+RAISE EXCEPTION/);
    expect(guard).toMatch(/IF '' ~\* ids THEN\s+RAISE EXCEPTION/);
  });

  test('translates Python word boundaries to Postgres ARE ones', () => {
    // \b in an ARE is a backspace: an untranslated pattern would match nothing.
    expect(guard).toContain("replace(replace(ids, '\\b', '\\y'), '\\B', '\\Y')");
  });

  test('scans every text-like column of every public table, parameterised', () => {
    expect(guard).toContain("c.table_schema = 'public'");
    for (const t of ["'text'", "'character varying'", "'jsonb'", "'json'", "'_text'"]) expect(guard).toContain(t);
    expect(guard).toContain('USING ids');
  });

  test('errors name table.column only — never values or the pattern', () => {
    for (const m of guard.matchAll(/RAISE EXCEPTION '([^']*)'(?:,\s*([^;]+))?;/g)) {
      const args = (m[2] ?? '').trim();
      if (args) expect(args).toMatch(/^array_to_string\(bad, ', '\)$/);
      expect(m[1]).not.toMatch(/ids/);
    }
  });

  test('checks placeholder shapes for the columns most likely to leak', () => {
    for (const k of ["('teams', 'name'", "('workspaces', 'name'", "('github_repos', 'full_name'",
      "('missions', 'title'", "('tasks', 'title'", "('workers', 'branch'", "('workers', 'pr_url'",
      "('mission_notes', 'body'", "('artifacts', 'title'", "('users', 'email'"]) {
      expect(guard).toContain(k);
    }
  });
});
