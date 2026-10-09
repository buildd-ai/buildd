import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MISSION_PR_TASK_PREFIX } from '../../packages/core/mission-integration';
import { knownColumns, latestSnapshotPath, textColumns } from './known-columns';

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
 *
 * That only covers this checkout's schema. Columns prod has and this checkout
 * does not (a branch lagging prod) are overwritten by scrub-pii.sql's last
 * block, from scripts/qa/known-columns.ts; see the tests for it below.
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

interface Assignment { table: string; column: string; expr: string }

function sqlCoverage(sql: string) {
  const body = stripComments(sql);
  // Only statements outside function bodies ($f$ … $f$).
  const top = body.replace(/\$f\$[\s\S]*?\$f\$/g, '');
  const assigned = new Map<string, Set<string>>();
  const assignments: Assignment[] = [];
  for (const m of top.matchAll(/\bUPDATE\s+([a-z_0-9]+)(?:\s+(?!SET\b)[a-z_0-9]+)?\s+SET\s+([\s\S]*?)(?=\bFROM\b|\bWHERE\b|;)/gi)) {
    const table = m[1];
    const set = assigned.get(table) ?? new Set<string>();
    for (const part of splitTopLevel(m[2])) {
      const a = /^\s*([a-z_0-9]+)\s*=([\s\S]*)$/.exec(part);
      if (!a) continue;
      set.add(a[1]);
      assignments.push({ table, column: a[1], expr: a[2].trim() });
    }
    assigned.set(table, set);
  }
  const wiped = new Set<string>();
  for (const m of top.matchAll(/\bDELETE\s+FROM\s+([a-z_0-9]+)/gi)) wiped.add(m[1]);
  for (const m of top.matchAll(/\bTRUNCATE\s+([a-z_0-9,\s]+?);/gi)) {
    for (const t of m[1].split(',')) wiped.add(t.trim());
  }
  return { assigned, wiped, top, assignments };
}

interface UniqueKey { table: string; name: string; columns: string[]; nullsNotDistinct: boolean }

/** Unique indexes/constraints per table, as SQL column names: column-level
 *  `.unique()`, `uniqueIndex('…').on(…)` and `unique('…').on(…)`. Partial
 *  indexes (`.where`) count as unique: the scrubbed rows may well match. */
function schemaUniqueKeys(src: string): UniqueKey[] {
  const starts = [...src.matchAll(/pgTable\(\s*'([a-z_0-9]+)'/g)].map(m => ({ table: m[1], at: m.index! }));
  const keys: UniqueKey[] = [];
  starts.forEach((s, i) => {
    const body = src.slice(s.at, starts[i + 1]?.at ?? src.length);
    const sqlName = new Map<string, string>();
    for (const line of body.split('\n')) {
      const m = /^\s+(\w+):\s*\w+\(\s*'([a-z_0-9]+)'/.exec(line);
      if (!m) continue;
      sqlName.set(m[1], m[2]);
      if (/\.unique\(\)/.test(line)) keys.push({ table: s.table, name: `${m[2]} (column)`, columns: [m[2]], nullsNotDistinct: false });
    }
    for (const m of body.matchAll(/\b(?:uniqueIndex|unique)\(\s*'([^']+)'\s*\)\s*\.on\(([^)]*)\)([^\n]*(?:\n\s*\.[^\n]*)*)/g)) {
      const columns = [...m[2].matchAll(/\bt\.(\w+)/g)].map(c => sqlName.get(c[1]) ?? c[1]);
      keys.push({ table: s.table, name: m[1], columns, nullsNotDistinct: /\.nullsNotDistinct\(\)/.test(m[3]) });
    }
  });
  return keys;
}

/** What an assignment can collide on. 'constant': every non-NULL result is the
 *  same literal (CASE scaffolding and `x IS [NOT] NULL` tests aside).
 *  'null': it only ever writes NULL. 'lossy': a helper that maps distinct
 *  inputs to one output (lorem of the same length, PR URL keeping only the
 *  number). Otherwise it is per-row (id, row number, md5 of the old value). */
function collisionClass(expr: string): 'constant' | 'null' | 'lossy' | null {
  if (/^pg_temp\.qa_(text|lorem|str|url|pr_url|json)\(/.test(expr)) return 'lossy';
  const rest = expr
    .replace(/'(?:[^']|'')*'/g, ' LIT ')
    .replace(/::\w+(\[\])?/g, ' ')
    .replace(/[\w.]+\s+IS\s+(?:NOT\s+)?NULL\b/gi, ' ')
    .replace(/\|\||[()]/g, ' ');
  const words = rest.split(/\s+/).filter(Boolean);
  if (!words.every(w => /^(CASE|WHEN|THEN|ELSE|END|NULL|LIT)$/i.test(w))) return null;
  return words.includes('LIT') ? 'constant' : 'null';
}

/** Assignments that can write the same value to two rows of a unique key. */
function uniqueCollisions(assignments: Assignment[], keys: UniqueKey[], oneRow: Set<string>): string[] {
  const out: string[] = [];
  for (const a of assignments) {
    const cls = collisionClass(a.expr);
    if (!cls || oneRow.has(`${a.table}.${a.column}`)) continue;
    for (const k of keys) {
      if (k.table !== a.table || !k.columns.includes(a.column)) continue;
      if (cls === 'null' && !k.nullsNotDistinct) continue;
      out.push(`${a.table}.${a.column} (${cls}) vs ${k.name}`);
    }
  }
  return out;
}

// Constant assignments to a unique column that are safe because the UPDATE's
// WHERE pins them to at most one row.
const ONE_ROW = new Set([
  'users.email', // 'ci-qa@buildd.dev': LIMIT 1 owner, and only if no row has it yet
]);

// Structurally safe: ids, hashes, shas, enums without a literal $type, model
// ids, timestamps-as-text, cron/timezone, colours, counts, numeric/uuid json.
// Each entry is a decision; keep the reason next to anything non-obvious.
const SAFE: Record<string, string[]> = {
  teams: ['timezone', 'monthly_cost_month', 'budget_alerts_sent', 'enabled_inference_capabilities', 'inference_feature_modes', 'enabled_decision_shadows', 'decision_model',
    'chat_default_tier', // a chat tier name (CHAT_TIER_NAMES) or null
    'chat_retro', // { lessons, proposals } booleans (apps/web/src/lib/chat-retro/settings.ts)
    'permission_overrides', // permission names -> team role names, both fixed sets (lib/permission-registry.ts)
    'plan', 'billing_status', // fixed vocabularies (packages/core/entitlements.ts); stripe ids are wiped
    'managed_runner_plan', // { plan: fixed plan id, numeric limits, 'block'|'allow' } (lib/entitlements/plans.ts)
    'model_upgrade_policy', // { mode: fixed vocabulary, soakHours, ISO times, setBy: a row id } (packages/core/model-upgrade-policy.ts)
    'model_tier_ceilings'], // tier names keyed by fixed surfaces and workspace ids, a fixed overCapAuto, audit of ISO times + user/account ids (@buildd/shared model-tier-ceiling.ts)
  team_members: ['chat_allowed_tool_groups', // tool-group keys from a fixed set (lib/chat/registry.ts TOOL_GROUPS)
    'chat_composer_prefs', // { workspaceId: uuid | null, tier: CHAT_TIER_NAMES | null } (lib/chat/composer-prefs.ts)
    'model_tier_ceilings'], // { admin, self }: tier names by fixed surface, audit of ISO times + user ids (same shape family as teams.model_tier_ceilings)
  users: ['timezone'],
  workspaces: ['model_upgrade_policy'], // same shape as teams.model_upgrade_policy
  // Scopes are a fixed vocabulary; workspace restrictions contain only row references.
  accounts: ['monthly_cost_month', 'budget_alerts_sent', 'scopes', 'workspace_ids'],
  missions: ['status', // MissionStatusValue (@buildd/shared)
    'context_artifact_ids', 'last_notified_sha', 'criteria_rearm_fingerprint',
    'branch_refresh_head_sha'], // a git SHA, same class as last_notified_sha
  initiatives: ['context_artifact_ids'],
  tasks: [
    'status', 'required_capabilities', 'heartbeat_tick_anchor', 'ci_retry_head_sha',
    'conflict_retry_head_sha', 'reviewer_retry_head_sha', 'depends_on', 'predicted_model',
    'loop_state', 'subject_head_sha',
    'category_decision', // { v, source, keyword, jev, confidence, skipped?, at }: labels, numbers, a version, a timestamp
    // StoredVerdictDecision (lib/task-verdict.ts): fixed-vocabulary labels, a
    // hash, row ids, a model id, a timestamp, and a cause key naming CI checks.
    'verdict_decision',
  ],
  task_subject_reports: ['origin'],
  task_subject_claims: ['key_type', 'key_hash'],
  workers: ['status', 'pr_opened_base_sha', 'last_commit_sha',
    'cost_basis'], // fixed vocabulary (packages/core/cost-basis.ts COST_BASES)
  worker_action_events: ['action'],
  worker_prompt_composition_events: ['policy_version', 'backend', 'sections'],
  // Memory use ledger: ids of a memory / its chunk, plus two fixed vocabularies
  // (MemoryCaller, MemoryGate in packages/core/memory-retrieval.ts). No content.
  memory_uses: ['chunk_id', 'memory_id', 'caller', 'gated_by'],
  memory_extraction_attempts: ['source_id'], // a task id or review_feedback row id
  memories: ['source_id', // a task id or review_feedback row id (packages/core/memory-candidates.ts)
    'reverify_ref'], // 'pr:<number>'
  // Content-free by construction: ids, decision names, labels, error kinds.
  memory_decisions: ['memory_id', 'decision', 'version', 'verdict', 'rule', 'error', 'caller'],
  // Chat retro lessons: every text column is a fixed vocabulary or pattern
  // (apps/web/src/lib/chat-retro/vocab.ts LESSON_TEXT_COLUMNS, checked before
  // each write); evidence is refs, counts and labels. Cascades with conversations.
  chat_retros: ['status', 'skip_reason', 'intent', 'satisfied', 'primary_cause', 'fix_class', 'tool_name', 'signature', 'version', 'error', 'evidence'],
  artifacts: ['type'],
  mission_notes: ['delivered_to'],
  // tracked_branch is the runner's BUILDD_BRANCH (main/dev), same class as
  // github_repos.default_branch.
  worker_heartbeats: [
    'workspace_ids', 'runner_commit', 'runner_version', 'current_commit', 'disk_commit',
    'tracked_branch',
  ],
  // delegation: workspace/user/account ids, a fixed capability vocabulary and a
  // timestamp (packages/core/token-delegation.ts). No free text.
  task_schedules: ['cron_expression', 'timezone', 'last_heartbeat_state_hash', 'delegation'],
  github_installations: ['permissions'],
  github_repos: ['default_branch'],
  workspace_skills: ['content_hash', 'model', 'color', 'config_hash', 'config_storage_key'],
  task_outcomes: ['kind', 'complexity', 'classified_by', 'predicted_model', 'actual_model', 'total_cost_usd', 'exit_cause'],
  // arm: 'control' | 'treatment' or a tier_pool_arms id (docs/design/tier-model-pools.md).
  experiment_assignments: ['default_model', 'assigned_model', 'runner_cli_version', 'arm'],
  // Decision labels, versions and model ids; no user content.
  heartbeat_triage_looks: ['arm', 'prompt_version', 'model', 'pick', 'reason'],
  // Tier pools hold no text by design: shares and weight levels keyed by arm
  // id, model ids, and an audit log of those same shares plus a system actor
  // label. dial_state is a state label, arm ids, ISO times and a reason built
  // from a fixed sentence plus rates and model ids (packages/core/tier-dial.ts).
  tier_pools: ['allocation', 'weights', 'dial_state'],
  tier_pool_arms: ['model', 'stats'],
  tier_pool_changes: ['before', 'after', 'evidence', 'actor_system'],
  tenant_budgets: ['tenant_id'],
  // Model plans and usage receipts for sibling apps hold no content by design
  // (docs/design/shared-ai-kit.md §2): tiers, providers, model ids, a reason
  // code, and `kind`, an attribution label the API pattern-checks to
  // [A-Za-z0-9_.:-]{1,64} (lib/ai/plan.ts), so it cannot carry prose.
  ai_plans: ['requested_tier', 'tier', 'kind', 'provider', 'model', 'reason'],
  ai_usage: ['tier', 'surface', 'kind', 'provider', 'model', 'plan_source'],
  model_tier_registry: ['model'],
  change_intents: ['head_sha'],
  surface_reservations: ['head_sha', 'base_sha'],
  dark_check_alerts: ['check_name'],
  releases: ['head_sha', 'previous_sha', 'version'],
  dependency_releases: ['reason_code'], // stable machine code naming the matched rule
  release_tasks: ['commit_sha'],
  // exit_cause is NOT safe: normalizeErrorSignature() keeps words from the
  // error text, and the scrub guard caught identifying text surviving there.
  worker_terminal_records: ['summary_provenance'],
  migration_log: ['phase'], // multi-line literal-union $type
  credential_leases: ['held_by_runner_id'], // wiped via secrets cascade too
  user_feedback: ['entity_id'],
};

const schema = schemaTextColumns(schemaSrc);
const cov = sqlCoverage(sqlSrc);
const uniqueKeys = schemaUniqueKeys(schemaSrc);

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
      missions: ['title', 'description', 'working_branch', 'primary_pr_url', 'goal_criteria', 'branch_refresh_lease_token'],
      initiatives: ['title', 'description', 'kpis'],
      tasks: ['title', 'description', 'context', 'result', 'external_url', 'subject_branch'],
      workers: ['branch', 'pr_url', 'current_action', 'waiting_for', 'error', 'milestones', 'result_meta', 'runner'],
      mission_notes: ['title', 'body'],
      artifacts: ['title', 'content', 'metadata', 'share_token'],
      workspace_skills: ['name', 'slug', 'content', 'description'],
      task_schedules: ['name', 'task_template', 'last_error'],
      releases: ['run_url', 'deploy_url', 'failure_reason'],
      memories: ['title', 'content', 'tags', 'files'],
      worker_terminal_records: ['exit_cause', 'detail'],
    };
    const missing = Object.entries(must).flatMap(([t, cs]) =>
      cs.filter(c => !cov.assigned.get(t)?.has(c)).map(c => `${t}.${c}`));
    expect(missing).toEqual([]);
    for (const t of ['secrets', 'device_codes', 'oauth_codes', 'oauth_refresh_tokens', 'knowledge_chunks']) {
      expect(cov.wiped.has(t)).toBe(true);
    }
  });

  // `isMissionPrTask` recognises the mission-PR owner by its title prefix. A
  // scrub that rewrites it to "Task N: …" leaves every opted-in mission on the
  // clone without a mission PR, so Visual QA screenshots a completed, merged
  // mission under a "MISSION PR · NOT OPENED" banner that prod never shows.
  test('tasks.title keeps the mission-PR owner prefix, and the guard accepts it', () => {
    const titleExpr = cov.assignments.find(a => a.table === 'tasks' && a.column === 'title')?.expr ?? '';
    expect(titleExpr).toContain(`'${MISSION_PR_TASK_PREFIX}'`);
    expect(titleExpr).toContain(`substr(t.title, ${MISSION_PR_TASK_PREFIX.length + 1})`);
    const guard = readFileSync(join(__dirname, 'scrub-guard.sql'), 'utf8');
    const pattern = /\('tasks', 'title', '([^']*)'\)/.exec(guard)?.[1];
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern!);
    expect(re.test(`${MISSION_PR_TASK_PREFIX}Task 12: lorem ipsum`)).toBe(true);
    expect(re.test('Task 12: lorem ipsum')).toBe(true);
    expect(re.test('Ship mission: Real mission title')).toBe(false);
  });

  // `hasMemberScopedDeps` recognises surface audits by their title prefix.
  // A scrub that loses the prefix makes platform operator missions appear
  // as needing a decision on the clone when they actually don't.
  test('tasks.title keeps the [surface audit] prefix, and the guard accepts it', () => {
    const titleExpr = cov.assignments.find(a => a.table === 'tasks' && a.column === 'title')?.expr ?? '';
    expect(titleExpr).toContain("[surface audit]");
    expect(titleExpr).toContain("LIKE '[surface audit] %'");
    const guard = readFileSync(join(__dirname, 'scrub-guard.sql'), 'utf8');
    const pattern = /\('tasks', 'title', '([^']*)'\)/.exec(guard)?.[1];
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern!);
    expect(re.test('[surface audit] Task 12: lorem ipsum')).toBe(true);
    expect(re.test('[surface audit] round 1: Task 12: lorem ipsum')).toBe(true);
    expect(re.test('[surface audit] round 2: Task 12: lorem ipsum')).toBe(true);
    expect(re.test('[surface audit] Real audit name')).toBe(false);
    expect(re.test('Task 12: lorem ipsum')).toBe(true);
  });

  test('one transaction, fail on first error, quiet, no DETAIL in public logs', () => {
    expect(sqlSrc).toContain('\\set ON_ERROR_STOP on');
    expect(sqlSrc).toContain('\\set QUIET on');
    expect(sqlSrc).toContain('\\set VERBOSITY terse');
    const begin = cov.top.search(/^BEGIN;$/m);
    const commit = cov.top.search(/^COMMIT;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    // Every statement sits between them; only psql meta-commands precede BEGIN.
    expect(cov.top.slice(0, begin).replace(/^\\set [^\n]*$/gm, '').trim()).toBe('');
    expect(cov.top.slice(commit + 'COMMIT;'.length).trim()).toBe('');
    expect(cov.top.match(/\bBEGIN\s*;|\bCOMMIT\s*;|\bROLLBACK\b/gi)).toHaveLength(2);
  });

  test('no constant or lossy value is written to a unique-indexed column', () => {
    // Real prod shape: a constant collides on the second row and kills the
    // whole QA run (worker_heartbeats.local_ui_url vs (account_id, local_ui_url)).
    expect(uniqueCollisions(cov.assignments, uniqueKeys, ONE_ROW)).toEqual([]);
  });

  test('ONE_ROW exemptions are constant assignments that still exist', () => {
    for (const k of ONE_ROW) {
      const [t, c] = k.split('.');
      expect(cov.assignments.some(a => a.table === t && a.column === c && collisionClass(a.expr) === 'constant')).toBe(true);
    }
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

  test('the schema parser sees every text-like column the latest Drizzle snapshot has', () => {
    // A column declared in a shape the line regex misses would get neither a
    // decision here nor a place on the known list, silently.
    const seen = new Set(schema.cols.map(c => `${c.table}.${c.column}`));
    expect(knownColumns().filter(c => !seen.has(c))).toEqual([]);
  });

  // The coverage tests above only see this checkout's schema.ts, but the clone
  // is prod's schema plus this branch's migrations. A mission branch cut before
  // post_session_runs reached prod had no decision for it, so post_session_runs.facts
  // went to the guard raw. Everything this checkout doesn't know is overwritten.
  test('text columns the checkout does not know (prod ahead of the branch) are overwritten', () => {
    expect(cov.top).toContain("SET qa.known = :'known';");
    const block = /DO \$unknown\$[\s\S]*?\$unknown\$;/.exec(sqlSrc)?.[0] ?? '';
    // Fails closed on an empty or junk list, instead of wiping every column.
    expect(block).toMatch(/IF NOT coalesce\('tasks\.title' = ANY \(known\), false\) THEN\s+RAISE EXCEPTION/);
    // Same column types the guard scans.
    for (const t of ["'text'", "'character varying'", "'character'", "'json'", "'jsonb'", "'_text'", "'_varchar'"]) {
      expect(block).toContain(t);
    }
    expect(block).toContain("c.table_schema = 'public'");
    expect(block).toContain('NOT ((c.table_name || \'.\' || c.column_name) = ANY (known))');
    // Per-row placeholder for NOT NULL columns: a unique index cannot collide.
    expect(block).toContain('md5(%I::text)');
    expect(block).toContain('UPDATE %I SET %I = %s');
    // Inside the one transaction.
    expect(sqlSrc.indexOf('DO $unknown$')).toBeLessThan(sqlSrc.lastIndexOf('COMMIT;'));
  });

  test('a branch behind prod leaves the newer table off the known list', () => {
    // Replays the incident: the snapshot a lagging branch carries has no
    // post_session_runs, so its facts column is not "known" and gets overwritten.
    const snap = JSON.parse(readFileSync(latestSnapshotPath(join(root, 'packages/core/drizzle')), 'utf8'));
    expect(textColumns(snap)).toContain('post_session_runs.facts');
    delete snap.tables['public.post_session_runs'];
    const lagging = textColumns(snap);
    expect(lagging).not.toContain('post_session_runs.facts');
    expect(lagging).toContain('tasks.title');
  });

  test('the CI QA user is designated before the general user scrub', () => {
    const designate = sqlSrc.indexOf("email = 'ci-qa@buildd.dev'");
    const general = sqlSrc.indexOf("'@scrubbed.local'");
    expect(designate).toBeGreaterThan(-1);
    expect(general).toBeGreaterThan(designate);
  });
});

describe('unique-collision detector', () => {
  test('parses composite, column-level and nulls-not-distinct keys from the schema', () => {
    const find = (name: string) => uniqueKeys.find(k => k.name === name);
    expect(find('worker_heartbeats_local_ui_url_idx')).toEqual({
      table: 'worker_heartbeats', name: 'worker_heartbeats_local_ui_url_idx',
      columns: ['account_id', 'local_ui_url'], nullsNotDistinct: false,
    });
    expect(find('api_key (column)')?.table).toBe('accounts');
    expect(find('chat_directives_user_scope_text_unique')?.nullsNotDistinct).toBe(true);
    expect(find('ws_skills_team_slug_idx')?.columns).toEqual(['team_id', 'slug']);
  });

  test('catches the constant heartbeat URL that broke every QA dispatch', () => {
    const old = sqlCoverage(`UPDATE worker_heartbeats SET
      local_ui_url = 'http://localhost:8766',
      viewer_token = CASE WHEN viewer_token IS NULL THEN NULL ELSE 'scrubbed-' || md5(id::text) END;`);
    expect(uniqueCollisions(old.assignments, uniqueKeys, ONE_ROW))
      .toEqual(['worker_heartbeats.local_ui_url (constant) vs worker_heartbeats_local_ui_url_idx']);
  });

  test('classifies expressions', () => {
    expect(collisionClass("'http://localhost:8766'")).toBe('constant');
    expect(collisionClass("CASE WHEN w.x IS NULL THEN NULL ELSE 'a' END")).toBe('constant');
    expect(collisionClass("'[]'::jsonb")).toBe('constant');
    expect(collisionClass('NULL')).toBe('null');
    expect(collisionClass('pg_temp.qa_text(t.description)')).toBe('lossy');
    expect(collisionClass("'http://qa-' || replace(id::text, '-', '') || '.localhost:8766'")).toBeNull();
    expect(collisionClass("'team-' || s.n")).toBeNull();
    expect(collisionClass("pg_temp.qa_hash('artifact-', a.key)")).toBeNull();
  });

  test('a NULL only collides under NULLS NOT DISTINCT', () => {
    const key = { table: 't', name: 'k', columns: ['c'], nullsNotDistinct: false };
    const a = [{ table: 't', column: 'c', expr: 'NULL' }];
    expect(uniqueCollisions(a, [key], new Set())).toEqual([]);
    expect(uniqueCollisions(a, [{ ...key, nullsNotDistinct: true }], new Set())).toEqual(['t.c (null) vs k']);
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
