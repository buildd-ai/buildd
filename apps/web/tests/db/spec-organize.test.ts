/**
 * Organization (Living Specs §17), against real Postgres: a draft is filed
 * under an area by a confident answer, with undo that leaves the version
 * alone; every other answer is a suggestion; no model falls back to the
 * similarity suggestion; the sweep is idempotent and never moves a spec a
 * person placed; a person's move lands on the filing's ledger row; areas
 * count whatever their approval state, and never across workspaces; a cold
 * start proposes a taxonomy and creates nothing until accepted. The model is
 * stubbed; everything else is the real path.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, relateSpec } = await import('../../src/lib/specs/store');
const { organizeDeps, organizeNewSpec, organizeWorkspace, actOnFiling, readFiling } = await import('../../src/lib/specs/organize');
const { suggestParent, neighbourDeps } = await import('../../src/lib/specs/neighbours');
const { listAreas } = await import('../../src/lib/specs/areas');
import type { AreaClassification, AreaClassifyInput } from '../../src/lib/specs/areas';

const rand = () => Math.random().toString(36).slice(2, 10);
let teamId: string; let wsA: string; let admin: string;
const user = () => ({ kind: 'user' as const, userId: admin });

beforeAll(async () => {
  assertDbConfigured();
  const seeded = await seedWorkspace();
  teamId = seeded.teamId; wsA = seeded.workspaceId;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'admin')`);
  admin = u.id;
  // No similarity provider in this process: the corpus query is not what is under test.
  neighbourDeps.similar = async () => [];
});
afterEach(() => { organizeDeps.classify = undefined; organizeDeps.suggest = undefined; });

async function newWorkspace(): Promise<string> {
  const [ws] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, dispatch_transport) VALUES (${`w-${rand()}`}, ${teamId}::uuid, 'in_app') RETURNING id`);
  return ws.id;
}
async function spec(workspaceId: string, title: string, body: string, scope = 'feature', parentSpecId: string | null = null): Promise<string> {
  const d = await createSpecDraft(user(), { workspaceId, title, body, scope, parentSpecId }, { duplicates: false });
  if (!d.ok) throw new Error(d.error);
  return d.spec.id;
}
async function ledgerRow(): Promise<string> {
  const [r] = await q<{ id: string }>(sql`INSERT INTO decision_records (team_id, workspace_id, capability, fingerprint, applied, status) VALUES (${teamId}::uuid, ${wsA}::uuid, 'spec_area', ${`fp-${rand()}`}, true, 'applied') RETURNING id`);
  return r.id;
}
const row = async (id: string) => (await q<{ parent_spec_id: string | null; version: number }>(sql`SELECT parent_spec_id, version FROM specs WHERE id = ${id}::uuid`))[0]!;
const filings = async (specId: string) => q<{ kind: string; status: string; parent_spec_id: string | null; source: string; decision_record_id: string | null }>(sql`SELECT kind, status, parent_spec_id, source, decision_record_id FROM spec_filings WHERE spec_id = ${specId}::uuid ORDER BY created_at`);

/** A classifier that answers `areaId` at `p` (confident at the bar), or another answer. */
const answering = (fn: (input: AreaClassifyInput) => Partial<Extract<AreaClassification, { ran: true }>> | AreaClassification, seen?: AreaClassifyInput[]) =>
  async (input: AreaClassifyInput): Promise<AreaClassification> => {
    seen?.push(input);
    const r = fn(input);
    if ('ran' in r && r.ran === false) return r;
    return { ran: true, answer: 'area', areaId: null, p: 0.99, confident: false, model: 'typesafe/jev', decisionRecordId: null, shown: input.areas.length, omitted: 0, ...r } as AreaClassification;
  };

describe('one spec, after its create (R-7, R-9)', () => {
  test('AC-68: a confident area answer files it, records the filing, and undo restores the previous parent with the version unmoved', async () => {
    const area = await spec(wsA, `Payments ${rand()}`, '# Payments\nCharging cards, refunds and payouts.\n', 'domain');
    const draft = await spec(wsA, `Partial refunds ${rand()}`, '# Partial refunds\nRefund part of a payment.\n- **AC-1** A partial refund returns that amount.\n');
    const rec = await ledgerRow();
    organizeDeps.classify = answering((i) => ({ areaId: i.areas.find((a) => a.id === area)!.id, confident: true, decisionRecordId: rec }));
    const before = await row(draft);
    expect(await organizeNewSpec(draft, { by: 'test' })).toMatchObject({ outcome: 'filed', areaId: area });
    expect((await row(draft)).parent_spec_id).toBe(area);
    expect((await row(draft)).version).toBe(before.version);
    expect(await filings(draft)).toEqual([{ kind: 'filed', status: 'applied', parent_spec_id: area, source: 'model', decision_record_id: rec }]);
    const shown = await readFiling(user(), draft);
    expect(shown).toMatchObject({ ok: true, filing: { kind: 'filed', parent: { specId: area } } });

    const undo = await actOnFiling(user(), draft, { action: 'undo', filingId: (shown as any).filing.id });
    expect(undo.ok).toBe(true);
    expect(await row(draft)).toEqual({ parent_spec_id: null, version: before.version });
    expect((await filings(draft))[0]!.status).toBe('undone');
    const [o] = await q<{ human_override: Record<string, unknown> | null }>(sql`SELECT human_override FROM decision_records WHERE id = ${rec}::uuid`);
    expect(o!.human_override).toMatchObject({ decision: 'unfiled', parentSpecId: null, previousParentId: area });
  });

  test('AC-69: new_area, unsure, a low answer and an id outside the list leave the parent and show a suggestion', async () => {
    const ws = await newWorkspace();
    const area = await spec(ws, 'Search', '# Search\nFinding products.\n', 'domain');
    const cases: Array<[string, Parameters<typeof answering>[0]]> = [
      ['new_area', () => ({ answer: 'new_area', areaId: null })],
      ['unsure', () => ({ answer: 'unsure', areaId: null })],
      ['low', () => ({ areaId: area, p: 0.5, confident: false })],
      ['outside', () => ({ areaId: '00000000-0000-4000-8000-000000000000', confident: true })],
    ];
    for (const [name, fn] of cases) {
      const d = await spec(ws, `Draft ${name} ${rand()}`, `# Draft\nSomething about ${name}.\n`);
      organizeDeps.classify = answering(fn);
      const r = await organizeNewSpec(d, { by: 'test' });
      expect(r.outcome).toBe('suggested');
      expect((await row(d)).parent_spec_id).toBeNull();
      const f = await filings(d);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ kind: 'suggested', status: 'open', source: 'model' });
      if (name === 'low') expect(f[0]!.parent_spec_id).toBe(area);
      if (name === 'outside') expect(f[0]!.parent_spec_id).toBeNull();
    }
  });

  test('AC-70: no decision model or a provider error creates the draft with the similarity suggestion', async () => {
    const ws = await newWorkspace();
    const area = await spec(ws, 'Billing', '# Billing\nInvoices, refunds and card payments for customers.\n', 'domain');
    organizeDeps.classify = async () => ({ ran: false, reason: 'this team has no decision-model key' });
    const d = await spec(ws, 'Refund invoices', '# Refund invoices\nRefunds on customer invoices and card payments.\n');
    expect(await organizeNewSpec(d, { by: 'test' })).toMatchObject({ outcome: 'suggested', parentSpecId: area, source: 'similarity' });
    expect((await row(d)).parent_spec_id).toBeNull();
    // And the real classifier, with no key in this database, falls back the same way and never throws.
    organizeDeps.classify = undefined;
    const d2 = await spec(ws, 'Card refunds', '# Card refunds\nRefunds on card payments and invoices.\n');
    expect(await organizeNewSpec(d2, { by: 'test' })).toMatchObject({ outcome: 'suggested', source: 'similarity' });
  });
});

describe('areas are structure (R-30, R-8)', () => {
  test('AC-92: a workspace whose only area is a draft: the classifier and suggestParent both consider it; a retired one is skipped', async () => {
    const ws = await newWorkspace();
    const area = await spec(ws, 'Shipping', '# Shipping\nParcels, carriers, delivery tracking and labels.\n', 'domain');
    const retired = await spec(ws, 'Old shipping', '# Old shipping\nParcels, carriers, delivery tracking and labels.\n', 'domain');
    await q(sql`UPDATE specs SET status = 'retired' WHERE id = ${retired}::uuid`);
    expect((await row(area))).toBeTruthy();
    const seen: AreaClassifyInput[] = [];
    organizeDeps.classify = answering(() => ({ answer: 'unsure', areaId: null }), seen);
    const d = await spec(ws, 'Tracking page', '# Tracking page\nShow parcel delivery tracking from the carrier.\n');
    await organizeNewSpec(d, { by: 'test' });
    expect(seen[0]!.areas.map((a) => a.id)).toEqual([area]);
    expect(await suggestParent(ws, d, 'Tracking page\n\nShow parcel delivery tracking from the carrier.')).toMatchObject({ specId: area });
  });

  test('AC-73: an area in workspace B is never in A\'s state, and a filing naming it is refused', async () => {
    const wsB = await newWorkspace();
    const foreign = await spec(wsB, 'Payments B', '# Payments\nCharging cards.\n', 'domain');
    const ws = await newWorkspace();
    const local = await spec(ws, 'Search', '# Search\nFinding things.\n', 'domain');
    const seen: AreaClassifyInput[] = [];
    organizeDeps.classify = answering(() => ({ areaId: foreign, confident: true }), seen);
    const d = await spec(ws, 'Card capture', '# Card capture\nCharging cards.\n');
    expect((await organizeNewSpec(d, { by: 'test' })).outcome).toBe('suggested');
    expect(seen[0]!.areas.map((a) => a.id)).toEqual([local]);
    expect((await row(d)).parent_spec_id).toBeNull();
    expect((await listAreas(ws)).map((a) => a.id)).not.toContain(foreign);
  });
});

describe('the sweep and a person (R-10, R-11)', () => {
  test('AC-71: a second run with nothing changed is empty, and a spec a person moved is never moved by a run', async () => {
    const ws = await newWorkspace();
    const pay = await spec(ws, 'Payments', '# Payments\nCards.\n', 'domain');
    const other = await spec(ws, 'Search', '# Search\nFinding.\n', 'domain');
    const a = await spec(ws, 'Refunds', '# Refunds\nMoney back.\n');
    const b = await spec(ws, 'Facets', '# Facets\nFilters.\n');
    const moved = await spec(ws, 'Payouts', '# Payouts\nMoney out.\n');
    // A person files Payouts under Search, then un-files it: it stays theirs.
    expect((await relateSpec(user(), moved, { parentSpecId: other })).ok).toBe(true);
    expect((await relateSpec(user(), moved, { parentSpecId: null })).ok).toBe(true);
    organizeDeps.classify = answering((i) => (i.specId === b ? { answer: 'unsure', areaId: null } : { areaId: pay, confident: true }));

    const dry = await organizeWorkspace(user(), { workspaceId: ws });
    expect(dry).toMatchObject({ ok: true, result: { mode: 'sweep', dryRun: true, scanned: 2 } });
    expect((await row(a)).parent_spec_id).toBeNull(); // a dry run writes nothing

    const first = await organizeWorkspace(user(), { workspaceId: ws, dryRun: false });
    if (!first.ok || first.result.mode !== 'sweep') throw new Error('expected a sweep');
    expect(first.result.scanned).toBe(2);
    const payGroup = first.result.groups.find((g) => g.area?.specId === pay)!;
    expect(payGroup.filed.map((r) => r.specId)).toEqual([a]);
    expect(first.result.groups.find((g) => g.label === 'Unsure')!.suggested.map((r) => r.specId)).toEqual([b]);
    expect((await row(a)).parent_spec_id).toBe(pay);
    expect((await row(moved)).parent_spec_id).toBeNull();

    const second = await organizeWorkspace(user(), { workspaceId: ws, dryRun: false });
    expect(second).toMatchObject({ ok: true, result: { mode: 'sweep', scanned: 0, groups: [] } });
    expect((await row(moved)).parent_spec_id).toBeNull();
  });

  test('AC-72: a person moving a spec buildd filed records a human override naming the new parent', async () => {
    const ws = await newWorkspace();
    const pay = await spec(ws, 'Payments', '# Payments\nCards.\n', 'domain');
    const search = await spec(ws, 'Search', '# Search\nFinding.\n', 'domain');
    const d = await spec(ws, `Refunds ${rand()}`, '# Refunds\nMoney back.\n');
    const rec = await ledgerRow();
    organizeDeps.classify = answering(() => ({ areaId: pay, confident: true, decisionRecordId: rec }));
    expect((await organizeNewSpec(d, { by: 'test' })).outcome).toBe('filed');
    expect((await relateSpec(user(), d, { parentSpecId: search })).ok).toBe(true);
    const [o] = await q<{ human_override: Record<string, unknown> | null; overridden_by: string | null }>(sql`SELECT human_override, overridden_by FROM decision_records WHERE id = ${rec}::uuid`);
    expect(o!.human_override).toMatchObject({ decision: 'moved', parentSpecId: search, previousParentId: pay });
    expect(o!.overridden_by).toBe(admin);
    const f = await filings(d);
    expect(f.map((x) => [x.kind, x.status])).toEqual([['filed', 'overridden'], ['manual', 'applied']]);
  });
});

describe('cold start (R-4)', () => {
  test('AC-66: with no product or area, organize proposes one taxonomy and creates nothing until a person accepts it', async () => {
    const ws = await newWorkspace();
    const fm = (domain: string) => `---\ntitle: x\ndomain: ${domain}\n---\n`;
    const made = [
      await spec(ws, 'Invoices', `${fm('billing')}# Invoices\nInvoice payment refund charge card.\n`),
      await spec(ws, 'Refunds', `${fm('billing')}# Refunds\nInvoice payment refund charge card.\n`),
      await spec(ws, 'Ranking', `${fm('search')}# Ranking\nQuery index ranking filter facet.\n`),
      await spec(ws, 'Facets', `${fm('search')}# Facets\nQuery index ranking filter facet.\n`),
      await spec(ws, 'Sign in', `${fm('auth')}# Sign in\nLogin password session token.\n`),
      await spec(ws, 'Sessions', `${fm('auth')}# Sessions\nLogin password session token.\n`),
    ];
    const count = async () => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${ws}::uuid`))[0]!.n;
    const dry = await organizeWorkspace(user(), { workspaceId: ws });
    if (!dry.ok || dry.result.mode !== 'taxonomy' || !dry.result.dryRun) throw new Error('expected a taxonomy proposal');
    expect(dry.result.proposal.areas.map((a) => a.title).sort()).toEqual(['Auth', 'Billing', 'Search']);
    expect(await count()).toBe(made.length);

    const keys = dry.result.proposal.areas.filter((a) => a.title !== 'Auth').map((a) => a.key);
    const accepted = await organizeWorkspace(user(), { workspaceId: ws, dryRun: false, areas: keys, edits: { [keys[0]!]: { charter: 'A charter a person wrote.' } } });
    if (!accepted.ok || accepted.result.mode !== 'taxonomy' || accepted.result.dryRun) throw new Error('expected an accept');
    expect(accepted.result.product).not.toBeNull();
    expect(accepted.result.created.map((c) => c.filed)).toEqual([2, 2]);
    expect(await count()).toBe(made.length + 3); // the product and two areas
    const scopes = await q<{ scope: string; n: number }>(sql`SELECT scope, count(*)::int AS n FROM specs WHERE workspace_id = ${ws}::uuid AND scope IN ('product','domain') GROUP BY scope ORDER BY scope`);
    expect(scopes).toEqual([{ scope: 'domain', n: 2 }, { scope: 'product', n: 1 }]);
    expect((await row(made[4]!)).parent_spec_id).toBeNull(); // Auth was not accepted
    const invoices = await row(made[0]!);
    expect(invoices.parent_spec_id).toBeTruthy();
    expect((await filings(made[0]!))[0]).toMatchObject({ kind: 'filed', source: 'taxonomy' });
    // Now there are areas: the next run is a sweep, not a second taxonomy.
    organizeDeps.classify = async () => ({ ran: false, reason: 'no key' });
    expect(await organizeWorkspace(user(), { workspaceId: ws })).toMatchObject({ ok: true, result: { mode: 'sweep' } });
  });
});
