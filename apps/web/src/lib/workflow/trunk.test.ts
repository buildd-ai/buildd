/**
 * The trunk circuit breaker's pure pieces (docs/specs/workflow-state-kernel.md
 * §6.10, S24): policy, signatures, and what counts as "the trunk explains it".
 * The live path (incident rows, T25/T26, one trunk-fix task) runs on real
 * Postgres in apps/web/tests/db/workflow-matrix.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { checkRunsSummary, failingTestEntries, pendingCheckRuns, type CheckRunRow } from './github-facts';
import { failingEntries, failingTestsFromLog } from './failing-tests';
import {
  blockedOnResolvedSql, linkTrunkFixSql, openIncidentsForBaseSql, openOrJoinIncidentSql, recentSignatureDeliveriesSql, repairingCiOnBaseSql,
  resolveIncidentSql, touchIncidentSql, trunkFixAnchorSql, trunkIncidentSql, unresolvedIncidentsSql,
  DEFAULT_TRUNK_WINDOW_MINUTES, UNKNOWN_CI_SIGNATURE, ciSignature, signatureCheckNames, signatureChecks, trunkBreakerConfig, trunkExplains, trunkRecovered,
  trunkRecoveredOnRuns,
} from './trunk';
import { MAX_SIGNATURE_LENGTH, MAX_TESTS_PER_CHECK } from './trunk-signature';
import { trunkFixDescription, trunkFixTitle } from '@buildd/workflow-kernel/handlers/trunk';

describe('trunkBreakerConfig', () => {
  test('absent = on with the base-red rule only; false turns it off; the multi-delivery rule is opt-in', () => {
    expect(trunkBreakerConfig(null)).toEqual({ enabled: true, minDeliveries: null, windowMinutes: DEFAULT_TRUNK_WINDOW_MINUTES });
    expect(trunkBreakerConfig({ trunkBreaker: false }).enabled).toBe(false);
    expect(trunkBreakerConfig({ trunkBreaker: 'off' }).enabled).toBe(false);
    expect(trunkBreakerConfig({ trunkBreaker: { minDeliveries: 3, windowMinutes: 30 } })).toEqual({ enabled: true, minDeliveries: 3, windowMinutes: 30 });
    // One delivery is never a trunk: a threshold below 2 is ignored.
    expect(trunkBreakerConfig({ trunkBreaker: { minDeliveries: 1 } }).minDeliveries).toBeNull();
  });
});

describe('signatures', () => {
  test('sorted, normalised, deduplicated failing check names; nothing readable is the placeholder', () => {
    expect(ciSignature(['Unit tests (shard 2/4)', 'Lint', 'Unit tests (shard 3/4)'])).toBe('ci:lint|unit tests (shard <n>/<n>)');
    expect(ciSignature([])).toBe(UNKNOWN_CI_SIGNATURE);
    expect(signatureChecks('ci:a|b')).toEqual(['a', 'b']);
    expect(signatureChecks(UNKNOWN_CI_SIGNATURE)).toEqual([]);
  });

  test('the trunk explains a failure only when every failing PR check also fails on the base', () => {
    expect(trunkExplains('ci:unit', 'ci:lint|unit')).toBe(true);
    expect(trunkExplains('ci:lint|unit', 'ci:unit')).toBe(false); // the PR has its own failure too
    expect(trunkExplains(UNKNOWN_CI_SIGNATURE, 'ci:unit')).toBe(false); // unknown is never the trunk's
    expect(trunkExplains('ci:unit', UNKNOWN_CI_SIGNATURE)).toBe(false);
  });

  test('recovered when none of the incident checks fails on the base any more', () => {
    expect(trunkRecovered('ci:unit', [])).toBe(true);
    expect(trunkRecovered('ci:unit', ['Lint'])).toBe(true);
    expect(trunkRecovered('ci:lint|unit', ['Unit'])).toBe(false);
  });
});

describe('the DB architecture job runs on both refs under two names', () => {
  // build.yml names it "· merge ref" on a PR and "· branch HEAD" on a push to the base.
  const PR = 'DB architecture (real Postgres) · merge ref';
  const BASE = 'DB architecture (real Postgres) · branch HEAD';

  test('the ref under test does not change the check: base and PR failures share a signature', () => {
    const test = 'task page byte budget';
    expect(ciSignature(failingEntries(BASE, [test]))).toBe(ciSignature(failingEntries(PR, [test])));
    expect(trunkExplains(ciSignature(failingEntries(PR, [test])), ciSignature(failingEntries(BASE, [test])))).toBe(true);
  });

  test('a different failing test on the PR is still its own', () => {
    expect(trunkExplains(ciSignature(failingEntries(PR, ['b'])), ciSignature(failingEntries(BASE, ['a'])))).toBe(false);
  });
});

describe('signatures at test level: a shared job name is not a shared failure', () => {
  const SHARD1 = 'build · unit tests (1/3)';
  const SHARD2 = 'build · unit tests (2/3)';

  test("the trunk fails test A in shard 1/3 and the PR fails test B in shard 1/3: not the trunk's", () => {
    const base = ciSignature([...failingEntries(SHARD1, ['a11y guard > no native <select>']), 'build']);
    const pr = ciSignature([...failingEntries(SHARD1, ['module boundaries ratchet']), 'build']);
    expect(trunkExplains(pr, base)).toBe(false);
  });

  test('the same failing test explains the PR, in whichever shard it ran', () => {
    const base = ciSignature([...failingEntries(SHARD1, ['a11y guard']), 'build']);
    const pr = ciSignature([...failingEntries(SHARD2, ['a11y guard']), 'build']);
    expect(trunkExplains(pr, base)).toBe(true);
    // A PR failing the trunk's test and one of its own is the PR's.
    expect(trunkExplains(ciSignature([...failingEntries(SHARD2, ['a11y guard', 'jsonb casts ratchet']), 'build']), base)).toBe(false);
  });

  test("a shard name alone never matches: unread tests on either side are not the trunk's", () => {
    const unread = ciSignature(failingEntries(SHARD1, null));
    expect(trunkExplains(unread, unread)).toBe(false);
    expect(trunkExplains(unread, ciSignature(failingEntries(SHARD1, ['a11y guard'])))).toBe(false);
    expect(trunkExplains(ciSignature(failingEntries(SHARD1, ['a11y guard'])), unread)).toBe(false);
    // Read with tests on one side, bare on the other: no test-level match.
    expect(trunkExplains(ciSignature(failingEntries(SHARD1, ['a11y guard'])), ciSignature([SHARD1]))).toBe(false);
    // One unread shard leaves the whole check unread.
    expect(ciSignature([...failingEntries(SHARD1, ['a']), ...failingEntries(SHARD2, null)])).toBe('ci:build · unit tests (<n>/<n>)::?');
  });

  test('a check that failed with no test in its log (lint, a gate) still matches by name', () => {
    expect(trunkExplains(ciSignature(failingEntries('Lint', [])), ciSignature(['lint', ...failingEntries(SHARD1, ['x'])]))).toBe(true);
  });

  test('test names normalise like check names; many failing tests collapse; the signature stays bounded', () => {
    expect(ciSignature(['Unit::Suite > takes 120ms', 'Unit::Suite > takes 85ms'])).toBe('ci:unit::suite > takes <n>ms');
    expect(ciSignature(['unit::a|b'])).toBe('ci:unit::a/b');
    const many = Array.from({ length: MAX_TESTS_PER_CHECK + 1 }, (_, i) => `t${String.fromCharCode(97 + i)}`);
    expect(ciSignature(failingEntries('unit', many))).toBe('ci:unit::*');
    expect(trunkExplains(ciSignature(failingEntries('unit', many)), ciSignature(failingEntries('unit', [...many.slice(1), 'zz'])))).toBe(true);
    const long = Array.from({ length: 40 }, (_, i) => failingEntries(`job ${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''}`, ['y'.repeat(90)])).flat();
    expect(ciSignature(long).length).toBeLessThanOrEqual(MAX_SIGNATURE_LENGTH);
    expect(signatureCheckNames(ciSignature([...failingEntries('unit', ['a', 'b']), 'lint']))).toEqual(['lint', 'unit']);
  });

  test('recovery at test level: a different test failing in the same shard is a recovery; unread is not', () => {
    const inc = ciSignature(failingEntries(SHARD1, ['a11y guard']));
    expect(trunkRecovered(inc, failingEntries(SHARD1, ['other test']))).toBe(true);
    expect(trunkRecovered(inc, failingEntries(SHARD2, ['a11y guard']))).toBe(false);
    expect(trunkRecovered(inc, failingEntries(SHARD1, null))).toBe(false);
    // A test-less incident check is red while the check fails at all.
    expect(trunkRecovered('ci:lint', failingEntries('lint', ['x']))).toBe(false);
  });

  test("a base with runs still going recovers once the incident's own checks finished clean", () => {
    const inc = ciSignature(failingEntries(SHARD1, ['a11y guard']));
    expect(trunkRecoveredOnRuns(inc, { complete: true, failing: [], tests: [] })).toBe(true);
    expect(trunkRecoveredOnRuns(inc, { complete: false, failing: [], tests: [], pending: ['deploy preview'] })).toBe(true);
    expect(trunkRecoveredOnRuns(inc, { complete: false, failing: [], tests: [], pending: [SHARD2] })).toBe(false);
    // No pending list (a partial read): unknown.
    expect(trunkRecoveredOnRuns(inc, { complete: false, failing: [], tests: [] })).toBe(false);
    expect(trunkRecoveredOnRuns(inc, null)).toBe(false);
    expect(trunkRecoveredOnRuns(inc, { complete: true, failing: [SHARD1], tests: failingEntries(SHARD1, ['a11y guard']) })).toBe(false);
  });
});

describe('failing tests from a job log', () => {
  test('bun (fail) lines and jest/vitest marks, ANSI and timestamps stripped; nothing else', () => {
    const log = [
      '﻿2026-10-18T14:08:00.1234567Z bun test v1.2.0',
      '2026-10-18T14:08:01.0000000Z \u001b[32m(pass)\u001b[0m fine > works [1.20ms]',
      '2026-10-18T14:08:01.0000000Z \u001b[31m(fail)\u001b[0m a11y guard > no native <select> [12.34ms]',
      '2026-10-18T14:08:02.0000000Z (fail) module boundaries ratchet',
      '  ✕ jest thing (12 ms)',
      '  × vitest thing 3ms',
      '2026-10-18T14:08:03.0000000Z error: script "test" exited with code 1',
    ].join('\n');
    expect(failingTestsFromLog(log)).toEqual(['a11y guard > no native <select>', 'jest thing', 'module boundaries ratchet', 'vitest thing']);
    expect(failingTestsFromLog('Process completed with exit code 1.')).toEqual([]);
  });

  test('entries: per test, bare when the log names none, unread when it could not be read', async () => {
    expect(failingEntries('unit', ['a', 'b'])).toEqual(['unit::a', 'unit::b']);
    expect(failingEntries('lint', [])).toEqual(['lint']);
    expect(failingEntries('unit', null)).toEqual(['unit::?']);
    const runs: CheckRunRow[] = [
      { id: 1, name: 'unit', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
      { id: 2, name: 'lint', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
      { id: 3, name: 'vercel', status: 'completed', conclusion: 'failure', app: { slug: 'vercel' } },
      { id: 4, name: 'gone', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
      { id: 5, name: 'ok', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { id: 6, name: 'slow', status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } },
    ];
    const logs: Record<number, string> = { 1: '(fail) a\n(fail) b', 2: 'eslint: 3 problems' };
    const read: number[] = [];
    const entries = await failingTestEntries(runs, async (id) => { read.push(id); if (!(id in logs)) throw new Error('404'); return logs[id]; });
    expect(entries).toEqual(['unit::a', 'unit::b', 'lint', 'vercel', 'gone::?']);
    expect(read).toEqual([1, 2, 4]); // only the Actions jobs that failed
    expect(pendingCheckRuns(runs)).toEqual(['slow']);
  });
});

describe('checkRunsSummary', () => {
  test('failing completed runs by name; incomplete when any run is still going; no runs is unknown', () => {
    expect(checkRunsSummary([{ name: 'unit', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }]))
      .toEqual({ complete: true, failing: ['unit'] });
    expect(checkRunsSummary([{ name: 'unit', status: 'in_progress', conclusion: null }])).toEqual({ complete: false, failing: [] });
    expect(checkRunsSummary([])).toBeNull();
  });
});

describe('the trunk-fix task', () => {
  test('names the base and the failing checks, and the PRs it unblocks', () => {
    expect(trunkFixTitle('dev', 'ci:lint|unit')).toBe('fix(ci): dev is red — lint, unit');
    const d = trunkFixDescription({ repoFullName: 'acme/x', baseRef: 'dev', baseHeadSha: 'abcdef1234567890', signature: 'ci:unit', prNumbers: [7, 8] });
    expect(d).toContain('`abcdef123456`');
    expect(d).toContain('- unit');
    expect(d).toContain('#7, #8');
  });
});

describe('incident SQL (rendered through PgDialect)', () => {
  const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, ' ');
  const W = '00000000-0000-0000-0000-000000000001';
  const D = '00000000-0000-0000-0000-000000000002';
  test('open-or-join is one upsert on the open-signature index, bounded and idempotent per delivery', () => {
    const s = render(openOrJoinIncidentSql({ workspaceId: W, repoFullName: 'acme/x', baseRef: 'dev', signature: 'ci:unit', deliveryId: D }));
    expect(s).toContain('INSERT INTO trunk_incidents (workspace_id, repo_full_name, base_ref, signature, affected_deliveries)');
    expect(s).toContain("ON CONFLICT (workspace_id, repo_full_name, base_ref, signature) WHERE status <> 'resolved' DO UPDATE SET");
    expect(s).toContain('trunk_incidents.affected_deliveries ? $');
    expect(s).toContain('jsonb_array_length(trunk_incidents.affected_deliveries) >=');
    expect(s).toContain('RETURNING id, (xmax = 0) AS opened');
  });
  test('reads: open incidents on a base, recent signature count, repairing deliveries, unresolved incidents, blocked-on-resolved', () => {
    expect(render(openIncidentsForBaseSql(W, 'acme/x', 'dev'))).toContain("AND status <> 'resolved' ORDER BY first_seen_at");
    const recent = render(recentSignatureDeliveriesSql({ workspaceId: W, repoFullName: 'acme/x', signature: 'ci:unit', windowMinutes: 30, excludeDeliveryId: D }));
    expect(recent).toContain('count(DISTINCT wa.delivery_id)::int AS n');
    expect(recent).toContain("wa.family = 'ci' AND wa.trigger_reason = $");
    expect(recent).toContain('make_interval(mins => $');
    const rep = render(repairingCiOnBaseSql({ workspaceId: W, repoFullName: 'acme/x', baseRef: 'dev', excludeDeliveryId: D }));
    expect(rep).toContain("d.state = 'REPAIRING' AND d.state_reason = 'ci'");
    expect(rep).toContain("wa.status IN ('queued', 'running')");
    expect(render(unresolvedIncidentsSql(5))).toContain("WHERE status <> 'resolved' ORDER BY updated_at, id LIMIT $1::int");
    expect(render(blockedOnResolvedSql(5))).toContain("d.state = 'BLOCKED_ON_TRUNK' AND d.authority = 'kernel' AND i.status = 'resolved'");
  });
  test('the trunk-fix anchor: one fixer per unresolved base, never a resolved incident or a finished fixer', () => {
    const s = render(trunkFixAnchorSql(D));
    expect(s).toContain('SELECT COALESCE(o.trunk_fix_task_id, o.id) AS task_id');
    expect(s).toContain("o.base_ref = me.base_ref AND o.status <> 'resolved'");
    expect(s).toContain('o.workspace_id = me.workspace_id AND o.repo_full_name = me.repo_full_name');
    // An unlinked incident anchors only the incidents opened after it, so two drains in either order agree.
    expect(s).toContain('(o.trunk_fix_task_id IS NULL AND (o.first_seen_at, o.id) < (me.first_seen_at, me.id))');
    expect(s).toMatch(/t\.status NOT IN \(\$\d+::text, \$\d+::text, \$\d+::text\)/);
    expect(s).toContain('ORDER BY (o.first_seen_at, o.id) LIMIT 1');
  });
  test('the Trunk port reads one incident and links its fix only while it has none, is unresolved, and the task exists', () => {
    expect(render(trunkIncidentSql(D))).toContain('SELECT id, workspace_id, repo_full_name, base_ref, signature, status, trunk_fix_task_id, affected_deliveries FROM trunk_incidents WHERE id = $1::uuid');
    const link = render(linkTrunkFixSql(D, D));
    expect(link).toContain("UPDATE trunk_incidents SET trunk_fix_task_id = $1::uuid, status = 'fixing'");
    expect(link).toContain("WHERE id = $2::uuid AND trunk_fix_task_id IS NULL AND status <> 'resolved' AND EXISTS (SELECT 1 FROM tasks WHERE id = $3::uuid)");
  });
  test('a recheck that leaves an incident unresolved sends it to the back of the sweep', () => {
    expect(render(touchIncidentSql(D))).toContain("UPDATE trunk_incidents SET updated_at = now() WHERE id = $1::uuid AND status <> 'resolved'");
  });
  test('resolve is a CAS: only an unresolved incident resolves, once', () => {
    expect(render(resolveIncidentSql(D))).toContain("SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1::uuid AND status <> 'resolved' RETURNING id");
  });
});
