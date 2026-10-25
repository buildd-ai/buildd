/**
 * Approved Living Specs in the knowledge store: the chunks recall reads and the
 * graph built from the spec's own explicit references (never inferred).
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/living-spec-knowledge.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  aggregateSpecMatches,
  buildLivingSpecChunks,
  buildLivingSpecGraph,
  livingSpecChunkPrefix,
  livingSpecDraftChunkPrefix,
  livingSpecPieces,
  LIVING_SPEC_DRAFT_SOURCE_TYPE,
  LIVING_SPEC_SIMILAR_FLOOR,
  LIVING_SPEC_SOURCE_TYPE,
} from '../knowledge-store/living-spec';

const SPEC = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const approvedAt = new Date('2026-10-11T12:00:00Z');

const base = {
  specId: SPEC,
  workspaceId: WS,
  title: 'Bug Intake and Quality',
  revision: 3,
  contentHash: 'abc123',
  parentSpecId: PARENT,
  scope: 'feature',
  approvedAt,
  sourceUrl: 'https://buildd.dev/app/specs/x/approve',
};

describe('buildLivingSpecChunks', () => {
  test('a short body is its whole text, keyed by the spec and revision, carrying the approved revision', async () => {
    const chunks = await buildLivingSpecChunks({ ...base, body: '# Bug Intake\n\nEvery report lands on one incident.\n' });
    // One heading holding the whole text: the section would repeat it, so only the whole text.
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c.id).toBe(`${livingSpecChunkPrefix(SPEC)}@3#text`);
    expect(c.sourceType).toBe(LIVING_SPEC_SOURCE_TYPE);
    // No source path: a repo ingest prunes paths it did not see, and this is not a repo file.
    expect(c.sourcePath ?? null).toBeNull();
    expect(c.sourceUrl).toBe(base.sourceUrl);
    expect(c.content).toContain('Every report lands on one incident.');
    expect(c.lexicalText).toContain('Bug Intake and Quality');
    expect(c.metadata).toMatchObject({
      specId: SPEC, revision: 3, contentHash: 'abc123', parentSpecId: PARENT,
      scope: 'feature', workspaceId: WS, approvedAt: approvedAt.toISOString(), draft: false, chunkKind: 'text',
    });
    expect(c.sourceTs).toEqual(approvedAt);
  });

  test('R-102: the whole text, one chunk per section and one per criterion, each criterion carrying its id and section', async () => {
    const body = [
      '# Cart', '', 'The cart page.', '',
      '## Totals', '', '- **R-1** Totals are in the shopper currency.', '- **AC-1** GIVEN a basket THEN the total is in euros.', '',
      '## Empty', '', 'R-2: An empty cart shows the empty state.', '',
    ].join('\n');
    const chunks = await buildLivingSpecChunks({ ...base, body });
    const ids = chunks.map(c => c.id.slice(`${livingSpecChunkPrefix(SPEC)}@3#`.length));
    expect(ids).toEqual(['text', 's1', 's2', 's3', 'R-1', 'AC-1', 'R-2']);
    const r1 = chunks.find(c => c.id.endsWith('#R-1'))!;
    expect(r1.content).toBe('R-1: Totals are in the shopper currency.');
    expect(r1.metadata).toMatchObject({ chunkKind: 'criterion', criterionId: 'R-1', section: { id: 's2', title: 'Totals' } });
    expect(r1.lexicalText).toContain('Cart > Totals');
    const s3 = chunks.find(c => c.id.endsWith('#s3'))!;
    expect(s3.metadata).toMatchObject({ chunkKind: 'section', section: { id: 's3', title: 'Empty' } });
    // A section is its own text, not its children's.
    expect(chunks.find(c => c.id.endsWith('#s1'))!.content).not.toContain('Totals are');
    // Stable: the same body gives the same ids.
    expect((await buildLivingSpecChunks({ ...base, body })).map(c => c.id)).toEqual(chunks.map(c => c.id));
  });

  test('R-106: a draft revision is indexed under its own prefix and source type, marked draft', async () => {
    const writtenAt = new Date('2026-10-12T00:00:00Z');
    const [c] = await buildLivingSpecChunks({ ...base, approvedAt: null, writtenAt, draft: true, body: '# X\n\nR-1: A thing.\n' });
    expect(c.id).toBe(`${livingSpecDraftChunkPrefix(SPEC)}@3#text`);
    expect(c.id.startsWith(livingSpecChunkPrefix(SPEC))).toBe(false);
    expect(c.sourceType).toBe(LIVING_SPEC_DRAFT_SOURCE_TYPE);
    expect(c.metadata).toMatchObject({ draft: true, approvedAt: null });
    expect(c.sourceTs).toEqual(writtenAt);
  });

  test('a long body keeps every section and the whole text stays bounded', async () => {
    const section = (i: number) => `## Section ${i}\n\n${'Requirement text that goes on. '.repeat(80)}\n`;
    const body = `# Big spec\n\n${Array.from({ length: 40 }, (_, i) => section(i)).join('\n')}`;
    const a = await buildLivingSpecChunks({ ...base, body });
    expect(new Set(a.map(c => c.id)).size).toBe(a.length);
    expect(a.filter(c => c.metadata?.chunkKind === 'section').length).toBe(40);
    expect(a.find(c => c.id.endsWith('#s41'))!.content).toContain('## Section 39');
    for (const c of a) expect(c.content.length).toBeLessThanOrEqual(32_000);
  });

  test('an empty body yields no chunks', async () => {
    expect(await buildLivingSpecChunks({ ...base, body: '   \n' })).toEqual([]);
  });
});

describe('livingSpecPieces', () => {
  test('the pieces a duplicate check probes with, same derivation as the stored chunks', () => {
    const pieces = livingSpecPieces('# A\n\n## B\n\nR-1: One.\n');
    expect(pieces.map(p => [p.key, p.kind, p.criterionId ?? null])).toEqual([
      ['text', 'text', null], ['s2', 'section', null], ['R-1', 'criterion', 'R-1'],
    ]);
  });
});

describe('aggregateSpecMatches', () => {
  const hit = (specId: string, key: string, dense: number | undefined, extra: Record<string, unknown> = {}) => ({
    id: `living-spec:${specId}@1#${key}`, namespace: 'w:spec', corpus: 'spec' as const, sourceType: LIVING_SPEC_SOURCE_TYPE,
    sourcePath: null, sourceUrl: null, content: key, score: dense ?? 0.2,
    metadata: { specId, revision: 1, draft: false, criterionId: /^(R|AC)-/.test(key) ? key : undefined, ...extra },
    scoreBreakdown: dense === undefined ? { lexical: 0.2 } : { dense },
  });

  test('one row per spec at its best score, keeping the best criterion pair as the reason (AC-139)', () => {
    const got = aggregateSpecMatches([
      { probe: { key: 'text', criterionId: null }, results: [hit('b', 'text', 0.6), hit('c', 'text', 0.58)] },
      { probe: { key: 'AC-3', criterionId: 'AC-3' }, results: [hit('b', 'R-7', 0.91), hit('b', 'R-8', 0.7)] },
      { probe: { key: 'R-1', criterionId: 'R-1' }, results: [hit('b', 'R-8', 0.8)] },
    ], { limit: 5 });
    expect(got.map(m => m.specId)).toEqual(['b', 'c']);
    expect(got[0]).toMatchObject({ score: 0.91, mode: 'vector', pairs: [{ here: 'AC-3', there: 'R-7' }, { here: 'R-1', there: 'R-8' }] });
    expect(got[0]!.chunkIds).toContain('living-spec:b@1#R-7');
  });

  test('vector hits below the floor are dropped; lexical ranks are not cosines, so they have none', () => {
    const got = aggregateSpecMatches([
      { probe: { key: 'text', criterionId: null }, results: [hit('low', 'text', LIVING_SPEC_SIMILAR_FLOOR.vector - 0.01), hit('lex', 'text', undefined)] },
    ], { limit: 5 });
    expect(got.map(m => [m.specId, m.mode])).toEqual([['lex', 'lexical']]);
  });

  test('leaves out the spec itself and keeps at most limit, marking drafts', () => {
    const got = aggregateSpecMatches([
      { probe: { key: 'text', criterionId: null }, results: [hit('self', 'text', 0.99), ...['a', 'b', 'c'].map((s, i) => hit(s, 'text', 0.9 - i / 10, { draft: s === 'b' }))] },
    ], { limit: 2, excludeSpecId: 'self' });
    expect(got.map(m => [m.specId, m.draft])).toEqual([['a', false], ['b', true]]);
  });
});

describe('buildLivingSpecGraph', () => {
  const graph = (over: Partial<Parameters<typeof buildLivingSpecGraph>[0]> = {}) => buildLivingSpecGraph({
    workspaceId: WS, specId: SPEC, title: 'Child', revision: 3,
    parent: { specId: PARENT, title: 'Parent' },
    repoRefs: [
      { path: 'docs/specs/bug-intake-and-quality.md', commitSha: 'a'.repeat(40) },
      { path: 'docs/specs/failure-incident-recovery.md', commitSha: 'b'.repeat(40) },
    ],
    previousApprovedRevision: 2,
    ...over,
  });
  const edgeKeys = (g: ReturnType<typeof buildLivingSpecGraph>) =>
    g.edges.map(e => `${e.fromEntityKind}:${e.fromEntityKey} -${e.type}-> ${e.toEntityKind}:${e.toEntityKey}`).sort();

  test('parent, two repo refs and a prior approval are exactly four edges', () => {
    expect(edgeKeys(graph())).toEqual([
      `spec:${SPEC} -part_of-> spec:${PARENT}`,
      `spec_revision:${SPEC}@3 -references_doc-> file:docs/specs/bug-intake-and-quality.md`,
      `spec_revision:${SPEC}@3 -references_doc-> file:docs/specs/failure-incident-recovery.md`,
      `spec_revision:${SPEC}@3 -supersedes-> spec_revision:${SPEC}@2`,
    ].sort());
  });

  test('a repo file is the same entity the repo spec corpus uses (kind file, key = path)', () => {
    const files = graph().entities.filter(e => e.kind === 'file');
    expect(files.map(f => [f.key, f.canonicalName])).toEqual([
      ['docs/specs/bug-intake-and-quality.md', 'bug-intake-and-quality.md'],
      ['docs/specs/failure-incident-recovery.md', 'failure-incident-recovery.md'],
    ]);
  });

  test('the commit each reference is pinned at rides on the revision entity', () => {
    const rev = graph().entities.find(e => e.kind === 'spec_revision' && e.key === `${SPEC}@3`);
    expect(rev?.attributes).toMatchObject({
      repoRefs: [
        { path: 'docs/specs/bug-intake-and-quality.md', commitSha: 'a'.repeat(40) },
        { path: 'docs/specs/failure-incident-recovery.md', commitSha: 'b'.repeat(40) },
      ],
    });
  });

  test('no parent, no refs, first approval: no edges at all', () => {
    expect(graph({ parent: null, repoRefs: [], previousApprovedRevision: null }).edges).toEqual([]);
  });

  test('every edge is a derived spec edge, never an agent or inferred one', () => {
    for (const e of graph().edges) expect(e.rule.startsWith('living_spec:')).toBe(true);
  });
});

describe('buildLivingSpecGraph: derived edges (living-specs.md §14)', () => {
  const graphBase = { workspaceId: WS, specId: SPEC, title: 'Cart', revision: 2, parent: null, repoRefs: [], previousApprovedRevision: null };
  const TASK = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const ART = '66666666-6666-4666-8666-666666666666';

  test('criteria, the tasks answering for them, passes, design, files and neighbours, all under the derived rule', () => {
    const g = buildLivingSpecGraph({
      ...graphBase,
      derived: {
        criteria: [{ id: 'AC-1', text: 'Empty state.' }, { id: 'AC-2', text: 'Totals.' }],
        tasks: [{ taskId: TASK, title: 'build cart', criteria: ['AC-1', 'AC-9'], verified: [{ criterionId: 'AC-1', headSha: 'a'.repeat(40) }] }],
        design: { kind: 'artifact', ref: ART, version: '4' },
        implementedIn: { files: ['src/cart.ts', 'src/cart.ts', 'src/total.ts'], source: 'pr_files' },
        neighbours: [{ specId: OTHER, title: 'Refunds', score: 1.7 }, { specId: SPEC, title: 'self', score: 1 }],
      },
    });
    const derived = g.edges.filter((e) => e.rule.startsWith('living_spec:derived:'));
    const by = (rule: string) => derived.filter((e) => e.rule === `living_spec:derived:${rule}`);
    expect(by('criterion').map((e) => e.fromEntityKey)).toEqual([`${SPEC}@2#AC-1`, `${SPEC}@2#AC-2`]);
    // AC-9 is not a criterion of this revision: no edge for it.
    expect(by('answers_for').map((e) => [e.fromEntityKey, e.toEntityKey])).toEqual([[`${SPEC}@2#AC-1`, TASK]]);
    expect(by('verified').map((e) => [e.fromEntityKey, e.type])).toEqual([[`${SPEC}@2#AC-1`, 'outcome_of']]);
    expect(by('built_to').map((e) => [e.fromEntityKey, e.toEntityKind, e.toEntityKey])).toEqual([[`${SPEC}@2`, 'artifact', ART]]);
    expect(by('implemented_in:pr_files').map((e) => e.toEntityKey)).toEqual(['src/cart.ts', 'src/total.ts']);
    // A spec is never its own neighbour; a score is clamped to 0..1.
    expect(by('neighbour').map((e) => [e.toEntityKey, e.weight])).toEqual([[OTHER, 1]]);
    const crit = g.entities.find((e) => e.kind === 'spec_criterion' && e.key === `${SPEC}@2#AC-1`)!;
    expect(crit.attributes).toMatchObject({ criterionId: 'AC-1', verified: [{ taskId: TASK, headSha: 'a'.repeat(40) }] });
  });

  test('without derived input the graph is the stored one only', () => {
    const g = buildLivingSpecGraph(graphBase);
    expect(g.edges.some((e) => e.rule.startsWith('living_spec:derived:'))).toBe(false);
    expect(g.entities.some((e) => e.kind === 'spec_criterion')).toBe(false);
  });

  test('a path-manifest file list is labelled as such and weighs less than PR files', () => {
    const g = buildLivingSpecGraph({ ...graphBase, derived: { implementedIn: { files: ['src/a.ts'], source: 'path_manifest' } } });
    const e = g.edges.find((x) => x.rule === 'living_spec:derived:implemented_in:path_manifest')!;
    expect(e.weight).toBeLessThan(0.7);
  });
});
