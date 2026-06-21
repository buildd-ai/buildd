#!/usr/bin/env bash
# Build the spec-sync dev-loop corpus: code + docs from all four buildd sources,
# into a DEDICATED knowledge namespace, isolated from the product memory store.
#
# This is the internal spec-drift pipeline, NOT the product knowledge store.
# It uses a code-aware embedder (voyage-code-3, via ingest-knowledge.ts) and a
# dedicated SPEC_WORKSPACE_ID so chunks never collide with `{workspaceId}:memory`.
#
# Usage:
#   SPEC_WORKSPACE_ID=<uuid> DATABASE_URL=<db> [VOYAGE_API_KEY=<key>] \
#     bash .claude/skills/spec-sync/scripts/ingest-spec-corpus.sh
#
# Without VOYAGE_API_KEY: chunks are stored text-only (BM25/lexical search works,
# no semantic vectors). Idempotent: re-run anytime; prior chunks per file are cleared.
set -euo pipefail

: "${SPEC_WORKSPACE_ID:?Set SPEC_WORKSPACE_ID to a dedicated namespace id (NOT a product workspace)}"
: "${DATABASE_URL:?Set DATABASE_URL to the target Postgres (confirm the correct DB)}"

# Resolve repo roots (override via env if your checkout differs).
BUILDD="${BUILDD_DIR:-$HOME/buildd}"
DOCS="${BUILDD_DOCS_DIR:-$HOME/buildd-docs}"
SITE="${BUILDD_SITE_DIR:-$HOME/buildd-site}"
KB="${KNOWLEDGE_BASE_DIR:-$HOME/knowledge-base}"

INGEST="$BUILDD/packages/core/scripts/ingest-knowledge.ts"

if [[ -z "${VOYAGE_API_KEY:-}" ]]; then
  echo "WARN: VOYAGE_API_KEY unset — lexical-only ingest (no semantic vectors)." >&2
fi

echo "==> Spec-sync corpus → namespace ${SPEC_WORKSPACE_ID}:{code,docs}"

# buildd: code + docs (the source of truth). Exclude history from the CODE side —
# migrations + tests keep removed features semantically "alive" and produce false-green.
echo "==> [1/4] buildd (clean code + docs)"
INGEST_SKIP_DIRS=drizzle,__tests__ INGEST_SKIP_TESTS=1 bun "$INGEST" "$SPEC_WORKSPACE_ID" "$BUILDD/packages" --code-only || true
INGEST_SKIP_DIRS=drizzle,__tests__ INGEST_SKIP_TESTS=1 bun "$INGEST" "$SPEC_WORKSPACE_ID" "$BUILDD/apps" --code-only || true
bun "$INGEST" "$SPEC_WORKSPACE_ID" "$BUILDD/docs" --docs-only || true

# Downstream doc repos: docs only (we diff their claims against code)
echo "==> [2/4] buildd-docs (docs only)"
[[ -d "$DOCS" ]] && bun "$INGEST" "$SPEC_WORKSPACE_ID" "$DOCS" --docs-only || echo "skip: $DOCS not found"

echo "==> [3/4] buildd-site (docs only)"
[[ -d "$SITE" ]] && bun "$INGEST" "$SPEC_WORKSPACE_ID" "$SITE" --docs-only || echo "skip: $SITE not found"

echo "==> [4/4] knowledge-base (docs only)"
[[ -d "$KB" ]] && bun "$INGEST" "$SPEC_WORKSPACE_ID" "$KB" --docs-only || echo "skip: $KB not found"

echo "==> Done. Query via KnowledgeStore scoped to namespace prefix '${SPEC_WORKSPACE_ID}:'."
