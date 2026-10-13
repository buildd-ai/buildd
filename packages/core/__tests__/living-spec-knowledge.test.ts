/**
 * Approved Living Specs in the knowledge store: the chunks recall reads and the
 * graph built from the spec's own explicit references (never inferred).
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/living-spec-knowledge.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  buildLivingSpecChunks,
  buildLivingSpecGraph,
  livingSpecChunkPrefix,
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
  test('a short body is one chunk keyed by the spec, carrying the approved revision', async () => {
    const chunks = await buildLivingSpecChunks({ ...base, body: '# Bug Intake\n\nEvery report lands on one incident.\n' });
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c.id.startsWith(livingSpecChunkPrefix(SPEC))).toBe(true);
    expect(c.sourceType).toBe(LIVING_SPEC_SOURCE_TYPE);
    // No source path: a repo ingest prunes paths it did not see, and this is not a repo file.
    expect(c.sourcePath ?? null).toBeNull();
    expect(c.sourceUrl).toBe(base.sourceUrl);
    expect(c.content).toContain('Every report lands on one incident.');
    expect(c.lexicalText).toContain('Bug Intake and Quality');
    expect(c.metadata).toMatchObject({
      specId: SPEC, revision: 3, contentHash: 'abc123', parentSpecId: PARENT,
      scope: 'feature', workspaceId: WS, approvedAt: approvedAt.toISOString(),
    });
    expect(c.sourceTs).toEqual(approvedAt);
  });

  test('a long body is split at headings into stable, unique ids under one prefix', async () => {
    const section = (i: number) => `## Section ${i}\n\n${'Requirement text that goes on. '.repeat(80)}\n`;
    const body = `# Big spec\n\n${Array.from({ length: 40 }, (_, i) => section(i)).join('\n')}`;
    const a = await buildLivingSpecChunks({ ...base, body });
    const b = await buildLivingSpecChunks({ ...base, body });
    expect(a.length).toBeGreaterThan(10);
    expect(new Set(a.map(c => c.id)).size).toBe(a.length);
    expect(a.map(c => c.id)).toEqual(b.map(c => c.id));
    for (const c of a) expect(c.id.startsWith(`${livingSpecChunkPrefix(SPEC)}#`)).toBe(true);
    // Every character of the body is in some chunk.
    expect(a.map(c => c.content).join('\n')).toContain('## Section 39');
  });

  test('an empty body yields no chunks', async () => {
    expect(await buildLivingSpecChunks({ ...base, body: '   \n' })).toEqual([]);
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
