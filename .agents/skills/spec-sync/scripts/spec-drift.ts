/**
 * Spec-drift probe — the "brain" of the spec-sync loop.
 *
 * For each feature probe, query the dev-loop corpus on BOTH sides:
 *   - `:docs`  — what the doc/site/kb repos CLAIM
 *   - `:code`  — what the code (schema + routes + runner) actually HAS
 * and flag the asymmetry:
 *   - docs strong, code weak  → DOCUMENTED-NOT-BUILT (stale doc, e.g. "objectives")
 *   - code strong, docs weak  → SHIPPED-NOT-DOCUMENTED (missing doc, e.g. "codex backend")
 *   - both strong             → ALIGNED
 *   - both weak               → ABSENT (probe not relevant)
 *
 * Retrieval is the cheap, deterministic signal; an LLM judge (the agent layer in
 * SKILL.md) can confirm individual hits. This script proves the corpus discriminates.
 *
 * Usage:
 *   DATABASE_URL=... VOYAGE_API_KEY=... \
 *   bun .claude/skills/spec-sync/scripts/spec-drift.ts <SPEC_WORKSPACE_ID> [topK]
 */
import { PgVectorStore, buildNamespace } from '../../../../packages/core/knowledge-store/pg-vector-store';
import { getVoyageEmbedder } from '../../../../packages/core/knowledge-store/voyage-embedder';
import { getVoyageReranker } from '../../../../packages/core/knowledge-store/reranker';

// Seeded with known drift (objectives/recipes/heartbeat = removed; codex/secrets/
// knowledge/routing = shipped). Extend or replace with claims pulled from :docs.
const PROBES: Array<{ term: string; query: string }> = [
  { term: 'objectives', query: 'objectives goal tracking manage_objectives table linked tasks' },
  { term: 'recipes', query: 'task recipe reusable multi-step workflow with variables' },
  { term: 'heartbeat feature', query: 'heartbeat monitoring periodic health check checklist mission' },
  { term: 'codex backend', query: 'codex agent backend dual backend OpenAI codex SDK thread resume' },
  { term: 'unified secrets', query: 'secrets table encrypted credential purpose oauth_token codex_credential scoping' },
  { term: 'knowledge store', query: 'hybrid semantic lexical retrieval pgvector BM25 RRF rerank knowledge chunks' },
  { term: 'smart model routing', query: 'task kind complexity predicted model claim-time routing calibration' },
  { term: 'watched projects', query: 'watched projects CI health watcher auto-create task release PR failure' },
];

async function main() {
  const [workspaceId, topKArg] = process.argv.slice(2);
  if (!workspaceId) {
    console.error('Usage: spec-drift.ts <SPEC_WORKSPACE_ID> [topK]');
    process.exit(1);
  }
  const topK = parseInt(topKArg || '5', 10);
  // --evidence: emit per-probe top snippets as JSON for an LLM judge (interactive
  // Task agent, or `claude -p < evidence.json` in CI). Retrieval is the pre-filter;
  // the judge reads the evidence and rules implemented / removed / contradicted.
  const evidenceMode = process.argv.includes('--evidence');
  const snippet = (s: string) => s.replace(/\s+/g, ' ').slice(0, 240);
  const embedder = getVoyageEmbedder();
  if (!embedder) console.warn('[drift] VOYAGE_API_KEY unset — lexical-only; scores not comparable to semantic.');
  const store = new PgVectorStore(embedder, getVoyageReranker());

  const codeNs = buildNamespace(workspaceId, 'code');
  const docsNs = buildNamespace(workspaceId, 'docs');

  const rows: Array<{ term: string; code: number; docs: number; verdict: string; codePath: string; docsPath: string }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  for (const p of PROBES) {
    const [codeHits, docsHits] = await Promise.all([
      store.query(codeNs, { text: p.query, mode: 'hybrid', topK }),
      store.query(docsNs, { text: p.query, mode: 'hybrid', topK }),
    ]);
    if (evidenceMode) {
      evidence.push({
        term: p.term, query: p.query,
        code: codeHits.map(h => ({ path: h.sourcePath, score: +h.score.toFixed(3), text: snippet(h.content) })),
        docs: docsHits.map(h => ({ path: h.sourcePath, score: +h.score.toFixed(3), text: snippet(h.content) })),
      });
    }
    rows.push({
      term: p.term,
      code: codeHits[0]?.score ?? 0,
      docs: docsHits[0]?.score ?? 0,
      codePath: codeHits[0]?.sourcePath ?? '—',
      docsPath: docsHits[0]?.sourcePath ?? '—',
    });
  }

  // NOTE: scores SURFACE candidates; they do NOT decide drift. A reranker always
  // returns a best match, so a "documented-not-built" feature still scores moderately
  // on the code side (its semantic neighbor — e.g. "objectives" → the missions table).
  // The verdict comes from the JUDGE reading the evidence (--evidence), not these numbers.
  console.log('\n=== spec-drift: retrieval surface (NOT a verdict — feed --evidence to a judge) ===');
  for (const r of rows) {
    console.log(
      `${r.term.padEnd(22)} code=${r.code.toFixed(3)} (${r.codePath})  docs=${r.docs.toFixed(3)} (${r.docsPath})`
    );
  }
  if (evidenceMode) {
    console.log('\n=== EVIDENCE (JSON) — judge ruling: for each term, do the CODE snippets actually');
    console.log('=== implement it (real table/route/impl), or are they just semantic neighbors? ===');
    console.log(JSON.stringify({ workspaceId, evidence }, null, 2));
  } else {
    console.log('\nRe-run with --evidence and pass the JSON to a judge (Task agent, or `claude -p` in CI).');
  }
  process.exit(0);
}

main().catch(err => { console.error('[drift] Error:', err); process.exit(1); });
