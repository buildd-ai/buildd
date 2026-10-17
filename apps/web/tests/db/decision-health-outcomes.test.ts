/**
 * The all-features health read and the per-capability read count the same
 * outcome labels, on real SQL. Before, the all-features loaders kept only the
 * two agent-audit sources, so a feature whose labels come from its own adapter
 * (post-session analysis, strand follow-up, ...) read "0 labelled" there while
 * the per-capability call showed them.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { readDecisionHealthRows, readDecisionLedgerPage } = await import('@buildd/core/decision-ledger');
const { computeFeatureHealth, featureHealthByCapability } = await import('@buildd/core/decision-feature-health');
const { loadDecisionHealthRows } = await import('../../src/lib/admin/data');
const { healthObjectiveLookup } = await import('../../src/lib/decision-health-objectives');

const CAP = 'buildd.post_session_triage';
let teamId = '';
let workspaceId = '';

const record = async (verdict: string) => (await q<{ id: string }>(sql`INSERT INTO decision_records (team_id, workspace_id, capability, fingerprint, applied, status, verdict, applied_answer) VALUES (${teamId}::uuid, ${workspaceId}::uuid, ${CAP}, ${`fp-${crypto.randomUUID()}`}, true, 'applied', ${verdict}, ${verdict}) RETURNING id`))[0]!.id;
const label = (id: string, source: string, l: string) => q(sql`INSERT INTO decision_outcomes (decision_record_id, team_id, capability, source, label, observed_at) VALUES (${id}::uuid, ${teamId}::uuid, ${CAP}, ${source}, ${l}, now())`);

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  const [a, b, c, d, e] = [await record('analyse'), await record('skip'), await record('skip'), await record('analyse'), await record('skip')];
  await label(a, 'post_session_analysis', 'actionable');       // right
  await label(b, 'post_session_analysis', 'actionable');       // wrong
  await label(c, 'post_session_analysis', 'not_actionable');   // right
  await label(d, 'agent_audit', 'right');                       // audit grade, not an adapter label
  void e;                                                       // unlabelled
});

describe('health read: every label source', () => {
  const since = new Date(Date.now() - 3600_000);

  test('all-features and per-capability reads agree on coverage and on the scored accuracy', async () => {
    const objectiveFor = await healthObjectiveLookup();
    const all = await readDecisionHealthRows({ teamId, workspaceId, since });
    const allHealth = featureHealthByCapability(all.rows, all.outcomes, { objectiveFor }).get(CAP)!;

    const page = await readDecisionLedgerPage({ teamId, workspaceId, capability: CAP, since });
    const oneHealth = computeFeatureHealth(
      page.rows.map(r => ({ ...r, verdict: r.verdict ?? null, overridden: r.overriddenAt != null })),
      page.outcomes,
      { objective: objectiveFor(CAP) },
    );

    expect(allHealth.coverage.labelled.n).toBe(4);
    expect(allHealth.coverage.labelled).toEqual(oneHealth.coverage.labelled);
    expect(allHealth.outcomeGraded).toMatchObject({ n: 3, right: 2, wrong: 1 });
    expect(allHealth.outcomeGraded).toEqual(oneHealth.outcomeGraded);
    // The audit number stays its own: one audit grade, none from the adapter's labels.
    expect(allHealth.graded).toMatchObject({ n: 1, right: 1 });
  });

  test('the platform-owner loader reads the same labels', async () => {
    const admin = await loadDecisionHealthRows({ since, workspaceIds: [workspaceId] });
    const health = featureHealthByCapability(admin.rows, admin.outcomes, { objectiveFor: await healthObjectiveLookup() }).get(CAP)!;
    expect(health.coverage.labelled.n).toBe(4);
    expect(health.outcomeGraded).toMatchObject({ n: 3, right: 2, wrong: 1 });
  });
});
