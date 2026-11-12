# @buildd/knowledge-store

DB-agnostic hybrid retrieval engine, extracted from `@buildd/core` so apps outside
this monorepo (such as dispatch-family) can share the engine instead of
reinventing embeddings + RRF. **Shared code, not shared data** — each consumer
injects its own `@neondatabase/serverless` Drizzle handle and runs against its own
database.

## What's inside

- **`VoyageEmbedder`** — Voyage AI embeddings (`voyage-4-large` prose / `voyage-code-3` code), 1024-dim, asymmetric `document`/`query` input types.
- **`PgVectorStore`** — hybrid vector + lexical search fused with Reciprocal Rank Fusion, content-hash dedup, recency/supersession, optional graph expansion.
- **`VoyageReranker`** — cross-encoder rerank (optional; RRF order stands without it).
- **chunker / ingest** — `chunkText`, `chunkMarkdown`, `chunkCode`, `ingestFiles`.
- **entity graph** — extractor / resolver / edge-builder (Phase 2+, optional).

## Usage

```ts
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from '@buildd/knowledge-store';
import { db } from './your-app/db'; // any @neondatabase/serverless Drizzle handle

const store = new PgVectorStore(db, getVoyageEmbedder(), getVoyageReranker());

// namespace = "{scopeId}:{corpus}" — scopeId is your tenant/workspace/team id
await store.upsert('tenant-123:email', [{
  id: 'email-abc',
  content: 'Water bill $142.50 due Jul 15',
  sourceType: 'email',
  sourceTs: new Date('2026-07-01'),
  metadata: { from: 'utility@city.gov' },
}]);

const hits = await store.query('tenant-123:email', { text: 'when is the water bill due', mode: 'hybrid', topK: 5 });
```

## Schema

Apply `schema.sql` to your database (idempotent, `--> statement-breakpoint`-delimited
for HTTP drivers). The chunk table is required; the entity-graph tables are only
needed if you pass `entities`/`relations` or use `useGraph` queries.

## Requirements

- Postgres with the `vector` (pgvector) extension.
- `VOYAGE_API_KEY` in the environment (embedder/reranker return null without it, so the store degrades to lexical-only).
- `drizzle-orm` as a peer dependency.

## Relationship to `packages/core/knowledge-store`

Two implementations exist on purpose. This package is the portable engine: the
caller injects the database handle (`new PgVectorStore(db, embedder, reranker)`).
`packages/core/knowledge-store` is buildd's platform engine: it resolves buildd's
own database, per-team embedding config and Voyage budget guard
(`new PgVectorStore(embedder, reranker, opts)`), so it cannot be published as
this API. This package is frozen at the 0.2.0 contract that external consumers
import; new platform features land in core only. Converging them (core taking
the database as an injected dependency, then consuming this package) is a
separate refactor, not part of publishing.

## Publishing

Tag `knowledge-store-v<version>` (must equal `package.json` version and have a
`## <version>` CHANGELOG heading); `.github/workflows/publish-knowledge-store.yml`
publishes with npm provenance via trusted publishing.
