import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ks from '../src/index';

// The runtime names @buildd-ai/knowledge-store 0.2.0 exported. Consumers
// (external consumers) import these; removing or renaming one is a breaking change.
const V0_2_0_RUNTIME = [
  'buildTaskCard', 'buildPrCard', 'buildArtifactCard', 'buildPlanCard', 'renderPlanText',
  'truncate', 'CARD_CONTENT_CAP', 'PgVectorStore', 'buildNamespace', 'reciprocalRankFusion',
  'VoyageEmbedder', 'getVoyageEmbedder', 'getCodeEmbedder', 'getVoyageEmbedderForCorpus',
  'isCodeCorpus', 'VoyageReranker', 'getVoyageReranker', 'applyRerank', 'chunkText',
  'chunkMarkdown', 'chunkCode', 'ingestFiles', 'fileToChunks', 'recencyDecay',
  'applyRecencyAuthority', 'CORPUS_AUTHORITY', 'HALF_LIFE_DAYS', 'extractEntities',
  'buildEdges', 'buildOutcomeOfEdge', 'buildAgentRelationEdges', 'upsertEntity',
  'upsertAlias', 'resolveEntity', 'autoHealPendingRefs', 'insertPendingRef', 'upsertEdge',
  'upsertChunkEntity',
];

describe('@buildd/knowledge-store surface', () => {
  test.each(V0_2_0_RUNTIME)('exports %s', name => {
    expect((ks as Record<string, unknown>)[name]).toBeDefined();
  });

  test('PgVectorStore takes the database first (0.2.0 constructor)', () => {
    // (db, embedder, reranker = null): two required parameters.
    expect(ks.PgVectorStore.length).toBe(2);
  });

  test('buildNamespace keeps the {scope}:{corpus} shape', () => {
    expect(ks.buildNamespace('ws-1', 'memory')).toBe('ws-1:memory');
  });

  test('package metadata is the published identity', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@buildd/knowledge-store');
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.peerDependencies['drizzle-orm']).toBeDefined();
  });
});
