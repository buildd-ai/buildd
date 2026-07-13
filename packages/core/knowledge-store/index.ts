export type { KnowledgeStore, UpsertChunk, QueryResult, QueryParams, QueryMode, Corpus, Embedder, EmbedInputType, Reranker, EntityRef, RelationRef, EntityKind, RelationType, EntityUpsert, EdgeUpsert, PendingRef } from './types';
export {
  buildTaskCard,
  buildSessionCard,
  buildPrCard,
  buildArtifactCard,
  buildPlanCard,
  renderPlanText,
  truncate,
  CARD_CONTENT_CAP,
} from './cards';
export type { TaskCardInput, SessionCardInput, PrCardInput, ArtifactCardInput, PlanCardInput } from './cards';
export { PgVectorStore, buildNamespace, reciprocalRankFusion } from './pg-vector-store';
export { VoyageEmbedder, getVoyageEmbedder } from './voyage-embedder';
export { VoyageReranker, getVoyageReranker, applyRerank } from './reranker';
export { chunkText, chunkMarkdown, chunkCode, chunkCodeSymbols } from './chunker';
export { chunkPrDiff, chunkPrDiffFile, splitPatchHunks, PR_DIFF_CHUNK_OPTIONS } from './pr-diff-chunker';
export type { PrDiffFileInput, PrDiffMeta } from './pr-diff-chunker';
export type { ChunkOptions, ChunkPiece, SymbolSpan } from './chunker';
export { ingestFiles, fileToChunks } from './ingest';
export type { SourceFile, IngestResult } from './ingest';
export { recencyDecay, applyRecencyAuthority, CORPUS_AUTHORITY, HALF_LIFE_DAYS } from './recency-authority';
export { extractEntities } from './entity-extractor';
export type { ExtractEntityInput, SymbolInfo } from './entity-extractor';
// NOTE: symbol-extractor.ts is deliberately NOT re-exported here — it wraps the
// @ast-grep/napi native binary and must only be reached via dynamic import()
// from ingest paths so serverless bundles never depend on it statically.
export { extractFilePaths, fetchEntityCatalog, renderEntityCatalog } from './entity-catalog';
export type { CatalogEntity, EntityCatalogParams, RenderCatalogOptions } from './entity-catalog';
export { buildEdges, buildOutcomeOfEdge, buildAgentRelationEdges } from './edge-builder';
export type { EdgeBuilderInput, EdgeBuilderOutput, ImportInfo } from './edge-builder';
// SCIP precise code-graph parser (stream B2b). Pure (no child_process/fs/DB),
// so it's safe to re-export. The side-effectful invocation lives in
// scip-runner.ts, which is deliberately NOT re-exported here (child_process).
export {
  parseScipIndex,
  buildScipGraph,
  decodeScipIndex,
  parseScipSymbol,
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from './scip-parser';
export type {
  ScipIndex,
  ScipDocument,
  ScipOccurrence,
  ScipSymbolInformation,
  ScipGraph,
  ScipAliasSeed,
  ParsedScipSymbol,
} from './scip-parser';
export {
  upsertEntity,
  upsertAlias,
  resolveEntity,
  autoHealPendingRefs,
  insertPendingRef,
  upsertEdge,
  upsertChunkEntity,
} from './entity-resolver';
export {
  getKnowledgeHealth,
  computeFreshness,
  ALL_CORPORA,
  DEFAULT_STALE_AFTER_DAYS,
} from './health';
export type {
  KnowledgeHealth,
  CorpusStat,
  LastIngestJob,
  FreshnessVerdict,
  FreshnessInput,
  GetKnowledgeHealthOptions,
} from './health';
