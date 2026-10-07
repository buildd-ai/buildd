/**
 * The `ingestFact` funnel: natural keys, R2 live reads, first-application
 * replay, and SQL rendered through the real PgDialect.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { LivePr } from './commands';
import { constituentEvidenceSql, factKeyFor, findFactSql, ingestFact, insertFactSql, lastAppliedHeadFactSql, ownRefreshSql, projectEquivalentHeadSql, type GithubFactReader } from './facts';
import type { Exec } from './kernel';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const live = (headSha: string): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: 'acme/widgets', baseRef: 'dev' });
const delivery = (o: Record<string, unknown> = {}) => ({
  id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, state: 'WORKING', version: 2,
  current_head_sha: 'H1', current_round: 0, max_rounds: 3, approved_heads: [], composition_heads: [], ...o,
});

/** Routes each statement by its leading comment tag. */
function router(routes: Record<string, (text: string, params: unknown[]) => { rows?: unknown[] }>) {
  const seen: string[] = [];
  const exec: Exec = async (q) => {
    const { sql: text, params } = render(q);
    const tag = text.split('\n')[0].replace('-- workflow:', '');
    seen.push(tag);
    const fn = routes[tag];
    if (!fn) throw new Error(`no route for ${tag}`);
    return fn(text, params);
  };
  return { exec, seen };
}

describe('fact keys', () => {
  test('one natural key per kind; head facts key on the LIVE head', () => {
    expect(factKeyFor({ kind: 'delivery_opened', workspaceId: 'w', source: 's', ownerTaskId: 't', requiresPr: true })).toBe('open:t');
    expect(factKeyFor({ kind: 'pr_bound', workspaceId: 'w', source: 's', repoFullName: 'a/b', prNumber: 1, ownerTaskId: 't' })).toBe('bind:a/b#1');
    const head = { kind: 'head_observed', workspaceId: 'w', source: 's', repoFullName: 'a/b', prNumber: 1, hintedHeadSha: 'HINT' } as const;
    expect(factKeyFor(head, live('LIVE'), { headSha: 'H1', version: 4 })).toBe('head:a/b#1:H1->LIVE@v4');
    // A→B→A (34b69829): the return to an earlier head is its own fact, not a replay of the first.
    expect(factKeyFor(head, live('A'), { headSha: 'B', version: 5 })).not.toBe(factKeyFor(head, live('A'), { headSha: 'Z', version: 3 }));
  });
  test('SQL renders and is idempotent on (workspace, fact_key)', () => {
    const ins = render(insertFactSql({ workspaceId: 'w', kind: 'pr_bound', factKey: 'k', source: 'runner', payload: { a: 1 } }));
    expect(ins.sql).toContain('ON CONFLICT (workspace_id, fact_key) DO NOTHING');
    expect(ins.params).toEqual(['w', null, null, 'pr_bound', 'k', 'runner', '{"a":1}']);
    expect(render(findFactSql('w', 'k')).params).toEqual(['w', 'k']);
    const last = render(lastAppliedHeadFactSql('w', 'd1'));
    expect(last.sql).toContain('JOIN workflow_transitions t ON t.id = f.applied_transition_id');
    expect(last.sql).toContain("t.command = 'HeadObserved'");
    expect(last.params).toEqual(['w', 'd1']);
    const ev = render(constituentEvidenceSql('w', ['r1', 'r2']));
    expect(ev.sql).toContain('JOIN workflow_deliveries d ON d.id = r.delivery_id');
    expect(ev.params).toEqual(['w', '["r1","r2"]']);
  });
  test('T13 SQL: own refresh is a refresh_branch pinned to the previous head; the projection appends once, after the transition', () => {
    const own = render(ownRefreshSql('d1', 'H1'));
    expect(own.sql).toContain("kind = 'refresh_branch'");
    expect(own.sql).toContain("payload->>'headSha' = $2::text");
    expect(own.params).toEqual(['d1', 'H1']);
    const proj = render(projectEquivalentHeadSql('d1', 'H1', 'H2'));
    expect(proj.sql).toContain("r.effective_verdict = 'approve'");
    expect(proj.sql).toContain('NOT (COALESCE(t.context->');
    expect(proj.params).toEqual(['d1', 'H1', 'H1', 'H2', 'H2']);
  });
});

describe('ingestFact', () => {
  test('delivery_opened records the fact and applies DeliveryOpened linked to it', async () => {
    const { exec, seen } = router({
      insert_fact: () => ({ rows: [{ id: 'f1' }] }),
      load_view: () => ({ rows: [] }),
      transition: (text, params) => {
        expect(text).toContain('UPDATE workflow_facts wf SET applied_transition_id = t.id');
        expect(params).toContain('f1');
        return { rows: [{ transition_id: 'tr1', delivery_id: 'd1', version: 1 }] };
      },
    });
    const r = await ingestFact({ kind: 'delivery_opened', workspaceId: 'w1', source: 'runner', ownerTaskId: 't1', requiresPr: true }, { exec });
    expect(r).toMatchObject({ factId: 'f1', factKey: 'open:t1', firstSeen: true, result: 'applied', transitionId: 'tr1' });
    expect(seen).toEqual(['insert_fact', 'load_view', 'transition']);
  });

  test('R2: PR facts need a GitHub reader and act on its live head, not the hint', async () => {
    await expect(ingestFact({ kind: 'head_observed', workspaceId: 'w1', source: 'webhook', repoFullName: 'acme/widgets', prNumber: 7 }, { exec: async () => ({ rows: [] }) }))
      .rejects.toThrow('GitHub reader is required');
    const gh: GithubFactReader = { readPr: async () => null };
    expect(await ingestFact({ kind: 'head_observed', workspaceId: 'w1', source: 'webhook', repoFullName: 'acme/widgets', prNumber: 7 }, { exec: async () => ({ rows: [] }), github: gh }))
      .toMatchObject({ result: 'rejected', reason: 'live_read_failed' });

    const { exec } = router({
      load_view: () => ({ rows: [{ delivery: delivery(), rounds: [], attempts: [] }] }),
      insert_fact: (_t, params) => { expect(params).toContain('head:acme/widgets#7:H1->LIVE@v2'); return { rows: [{ id: 'f2' }] }; },
      find_transition: () => ({ rows: [] }),
      transition: (_t, params) => { expect(params).toContain('LIVE'); expect(params).not.toContain('HINT'); return { rows: [{ transition_id: 'tr2', delivery_id: 'd1', version: 3 }] }; },
    });
    const r = await ingestFact(
      { kind: 'head_observed', workspaceId: 'w1', source: 'webhook:synchronize', repoFullName: 'acme/widgets', prNumber: 7, hintedHeadSha: 'HINT' },
      { exec, github: { readPr: async () => live('LIVE') } },
    );
    expect(r).toMatchObject({ result: 'applied', factKey: 'head:acme/widgets#7:H1->LIVE@v2' });
  });

  test('head_observed asks the compare API whether the live head contains the bound attempt\'s local head', async () => {
    const asked: string[] = [];
    const { exec } = router({
      load_view: () => ({ rows: [{ delivery: delivery({ state: 'AWAITING_PUSH', bound_attempt_id: 'a1' }), rounds: [], attempts: [{ id: 'a1', family: 'review_fix', attempt_no: 1, mode: 'agent', bound_head_sha: 'H1', status: 'ended', max_attempts: 3, reported_shas: ['L2'] }] }] }),
      insert_fact: () => ({ rows: [{ id: 'f3' }] }),
      find_transition: () => ({ rows: [] }),
      transition: () => ({ rows: [{ transition_id: 'tr3', delivery_id: 'd1', version: 3 }] }),
    });
    const r = await ingestFact(
      { kind: 'head_observed', workspaceId: 'w1', source: 'webhook', repoFullName: 'acme/widgets', prNumber: 7 },
      { exec, github: { readPr: async () => live('M3'), contains: async (_r, a, h) => { asked.push(`${a}<${h}`); return true; } } },
    );
    // §9 containment of the local head, then §6.9 provenance: does the head descend from the bound head?
    expect(asked).toEqual(['L2<M3', 'H1<M3']);
    expect(r).toMatchObject({ result: 'applied' });
    if (r.result === 'applied') {
      expect(r.decision.toState).toBe('AWAITING_REVIEW');
      expect(r.decision.evidence.live).toMatchObject({ headSha: 'M3' });
    }
  });

  test('head_observed skips the provenance compare for a head the attempt already reported', async () => {
    const asked: string[] = [];
    const { exec } = router({
      load_view: () => ({ rows: [{ delivery: delivery({ state: 'FIXING', bound_attempt_id: 'a1' }), rounds: [], attempts: [{ id: 'a1', family: 'review_fix', attempt_no: 1, mode: 'agent', bound_head_sha: 'H1', status: 'running', max_attempts: 3, reported_shas: ['M3'] }] }] }),
      insert_fact: () => ({ rows: [{ id: 'f4' }] }),
      find_transition: () => ({ rows: [] }),
      transition: () => ({ rows: [{ transition_id: 'tr4', delivery_id: 'd1', version: 3 }] }),
    });
    await ingestFact(
      { kind: 'head_observed', workspaceId: 'w1', source: 'webhook', repoFullName: 'acme/widgets', prNumber: 7 },
      { exec, github: { readPr: async () => live('M3'), contains: async (_r, a, h) => { asked.push(a + '<' + h); return true; } } },
    );
    expect(asked).toEqual([]);
  });

  test('a duplicate fact returns the first application; an unapplied duplicate is applied again', async () => {
    const applied = router({
      insert_fact: () => ({ rows: [] }),
      find_fact: () => ({ rows: [{ id: 'f1', applied_transition_id: 'tr1' }] }),
      load_view: () => ({ rows: [{ delivery: delivery(), rounds: [], attempts: [] }] }),
    });
    expect(await ingestFact({ kind: 'delivery_opened', workspaceId: 'w1', source: 'runner', ownerTaskId: 't1', requiresPr: true }, { exec: applied.exec }))
      .toMatchObject({ result: 'duplicate', factId: 'f1', transitionId: 'tr1', firstSeen: false, reason: 'fact_seen', current: { state: 'WORKING', version: 2 } });

    const crashed = router({
      insert_fact: () => ({ rows: [] }),
      find_fact: () => ({ rows: [{ id: 'f1', applied_transition_id: null }] }),
      load_view: () => ({ rows: [] }),
      transition: () => ({ rows: [{ transition_id: 'tr9', delivery_id: 'd1', version: 1 }] }),
    });
    expect(await ingestFact({ kind: 'delivery_opened', workspaceId: 'w1', source: 'runner', ownerTaskId: 't1', requiresPr: true }, { exec: crashed.exec }))
      .toMatchObject({ result: 'applied', factId: 'f1', firstSeen: false });

    const vanished = router({ insert_fact: () => ({ rows: [] }), find_fact: () => ({ rows: [] }) });
    await expect(ingestFact({ kind: 'delivery_opened', workspaceId: 'w1', source: 'runner', ownerTaskId: 't1', requiresPr: true }, { exec: vanished.exec }))
      .rejects.toThrow('neither inserted nor found');
  });

  test('pr_bound binds through the owner task; adoption creates the delivery', async () => {
    const routes = (expectCreate: boolean) => router({
      load_view: () => ({ rows: expectCreate ? [] : [{ delivery: delivery({ pr_number: null, repo_full_name: null }), rounds: [], attempts: [] }] }),
      insert_fact: () => ({ rows: [{ id: 'f4' }] }),
      find_transition: () => ({ rows: [] }),
      transition: (text) => {
        expect(text.includes('INSERT INTO workflow_deliveries')).toBe(expectCreate);
        return { rows: [{ transition_id: 'tr4', delivery_id: 'd1', version: 1 }] };
      },
    });
    const gh = { readPr: async () => live('H1') };
    expect(await ingestFact({ kind: 'pr_bound', workspaceId: 'w1', source: 'runner', repoFullName: 'acme/widgets', prNumber: 7, ownerTaskId: 't1' }, { exec: routes(false).exec, github: gh })).toMatchObject({ result: 'applied' });
    expect(await ingestFact({ kind: 'pr_bound', workspaceId: 'w1', source: 'webhook', repoFullName: 'acme/widgets', prNumber: 7, ownerTaskId: 's1', adoption: true }, { exec: routes(true).exec, github: gh })).toMatchObject({ result: 'applied' });
  });

  test('pr_closed: a PR closed because its base branch is gone is CLOSED_UNMERGED(base_deleted), from a live branch read', async () => {
    const closedLive: LivePr = { ...live('H1'), state: 'closed', baseRef: 'mission/x', updatedAt: 'u1' };
    const run = async (branchExists: GithubFactReader['branchExists']) => {
      const asked: string[] = [];
      const { exec } = router({
        load_view: () => ({ rows: [{ delivery: delivery({ state: 'AWAITING_REVIEW' }), rounds: [], attempts: [] }] }),
        insert_fact: () => ({ rows: [{ id: 'f6' }] }),
        find_transition: () => ({ rows: [] }),
        transition: () => ({ rows: [{ transition_id: 'tr6', delivery_id: 'd1', version: 3 }] }),
      });
      const r = await ingestFact({ kind: 'pr_closed', workspaceId: 'w1', source: 'webhook:closed', repoFullName: 'acme/widgets', prNumber: 7 }, {
        exec, github: { readPr: async () => closedLive, ...(branchExists ? { branchExists: async (repo, ref) => { asked.push(`${repo}:${ref}`); return branchExists(repo, ref); } } : {}) },
      });
      return { r, asked };
    };
    const gone = await run(async () => false);
    expect(gone.asked).toEqual(['acme/widgets:mission/x']);
    expect(gone.r).toMatchObject({ result: 'applied' });
    if (gone.r.result === 'applied') expect(gone.r.decision).toMatchObject({ toState: 'CLOSED_UNMERGED', patch: { stateReason: 'base_deleted' } });
    // The base still exists, or the read failed: the cause is not known. Never guessed.
    for (const answer of [async () => true, async () => null, undefined] as const) {
      const r = (await run(answer)).r;
      if (r.result === 'applied') expect(r.decision.patch.stateReason).toBe('unknown');
    }
  });

  test('composition_attested resolves constituents from the ledger and cites the fact', async () => {
    const { exec } = router({
      constituent_evidence: () => ({ rows: [{ round_id: 'rx', head_sha: 'C1', status: 'decided', effective_verdict: 'approve', approved_heads: ['C1'], delivery_id: 'dx', pr_number: 3, repo_full_name: 'acme/widgets' }] }),
      insert_fact: () => ({ rows: [{ id: 'f5' }] }),
      load_view: () => ({ rows: [{ delivery: delivery({ state: 'AWAITING_REVIEW' }), rounds: [], attempts: [] }] }),
      find_transition: () => ({ rows: [] }),
      transition: () => ({ rows: [{ transition_id: 'tr5', delivery_id: 'd1', version: 3 }] }),
    });
    const r = await ingestFact({
      kind: 'composition_attested', workspaceId: 'w1', source: 'kernel',
      attestation: {
        repoFullName: 'acme/widgets', prNumber: 7, baseSha: 'B0', aggregateHeadSha: 'H1', method: 'patch_set_equal', verifiedAt: 'now', verifier: 'kernel',
        constituents: [{ deliveryId: 'dx', roundId: 'rx', prNumber: 3, reviewedHeadSha: 'C1', equivalentHeadShas: [], mergedHeadSha: 'C1', landedSha: 'SQ1', landedPatchId: 'a'.repeat(64), reviewedPatchId: 'a'.repeat(64) }],
        novelDelta: { result: 'none' },
      },
    }, { exec });
    expect(r).toMatchObject({ result: 'applied', factKey: 'compose:acme/widgets#7:H1' });
    if (r.result === 'applied') {
      expect(r.decision.toState).toBe('APPROVED');
      expect(r.decision.evidence.factId).toBe('f5');
      expect(r.decision.patch.approvedHeads).toBeUndefined();
    }
  });
});
