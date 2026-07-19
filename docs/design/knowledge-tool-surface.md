# Knowledge Tool Surface: `recall` / `learn`

**Status:** Proposed
**Supersedes:** `buildd_memory` (8-action dispatch tool)
**Related:** `docs/design/knowledge-graph-retrieval.md`, Knowledge Layer Elevation mission

---

## Problem

`buildd_memory` exposes eight actions behind one dispatch parameter: `context`, `search`, `save`, `get`, `update`, `delete`, `query_knowledge`, `consolidate_knowledge`. The surface has four defects:

1. **Two retrieval paths compete.** `search` (lexical metadata filter) and `query_knowledge` (hybrid semantic across eight corpora) overlap. Nothing at the top level signals which is the default. Agents select `search` because the name is more obvious, and get materially worse results.

2. **The load-bearing instruction is buried.** "Use corpus=memory BEFORE starting work — builders should query for the task title and any error message before diagnosing" lives several hundred words deep inside the `params` blob, under one action. A model scanning tool names and one-line descriptions to decide what to reach for never sees it. The tool's own top-line reads `"Search, save, and manage shared team memories"` — which frames it as an optional scratchpad rather than as prior art that prevents rediscovering known bugs.

3. **Deduplication is delegated to the caller.** The description instructs callers to query for near-duplicates before saving. A caller who forgets writes a duplicate. The tool owns the embedding index; it should own the check.

4. **Admin ops share the builder hot path.** `consolidate_knowledge` carries its own vocabulary (`find_duplicates`, `find_decayed`, `halfLifeMultiple`, archive semantics) and is used by exactly one weekly task. Every builder pays its schema cost on every context load.

Secondary: three MCP servers (Builldd, cue, Moa-Ops) each expose an identical copy of this tool against what is one team memory namespace — triple schema cost for a single logical store.

---

## Design

Two tools. No dispatch parameter. The verb is the tool name.

### `recall` — read

Absorbs `search`, `query_knowledge`, `get`, and `context`.

```
recall(
  query: string,          // required — natural language; the task title or error text
  scope?: Scope,          // default "memory"
  type?: MemoryType,      // gotcha | pattern | decision | discovery | architecture
  files?: string[],       // narrow to entries touching these paths
  limit?: number,         // default 10
  id?: string             // direct fetch; bypasses ranking
)
```

`Scope` = `memory | task | pr | plan | artifact | code | docs | spec`

**Description (top-line, verbatim):**

> Team knowledge base. Query this BEFORE starting work or diagnosing a failure — it holds prior gotchas, architecture decisions, and outcomes of past tasks, and will frequently contain the answer already. Pass the task title and any error message.

**Behavior:**

- Retrieval mode is server-chosen. Hybrid by default; the server may fall back to lexical for short exact-match queries (IDs, symbol names, error strings). Callers cannot select mode — they lack the information to choose well.
- Namespace resolution is internal. The `{teamId}:memory` vs `{workspaceId}:{corpus}` split is an implementation detail and must not appear in the schema.
- `id` present ⇒ direct fetch, other params ignored.
- Returns ranked results with `sourceUrl`, `type`, and supersede state. Superseded entries are excluded unless `includeSuperseded` is set (admin only).

### `learn` — write

Absorbs `save` and `update`. Upsert semantics; there is no create-vs-update distinction at the call site.

```
learn(
  type: MemoryType,       // required
  title: string,          // required
  content: string,        // required
  files?: string[],
  tags?: string[],
  scope?: string,         // project/monorepo scoping
  supersedes?: string[]   // explicit override of auto-dedupe
)
```

**Description (top-line, verbatim):**

> Record a durable lesson for the team — a gotcha, pattern, decision, discovery, or architecture fact. Write what the next agent would have wanted to know. Near-duplicates are merged automatically.

**Behavior — the one real change:**

On write, the server embeds the entry and checks cosine similarity against the namespace:

| Similarity | Action |
|---|---|
| `> 0.94` | Auto-supersede the prior entry. Return the merged ID and `superseded: n`. |
| `0.88 – 0.94` | Return `conflict` with the candidate entries and their IDs. Caller resolves by re-calling with explicit `supersedes`. |
| `< 0.88` | Write as new. |

Thresholds are configuration, not schema. The caller is never asked to run a dedupe query first.

Memory is append-only. Superseded entries drop out of default retrieval but remain queryable via history — nothing is destroyed.

---

## Evictions

| Removed | Rationale |
|---|---|
| `context` | Exists to dump markdown for injection at agent claim time. The Knowledge Layer Elevation mission replaces content injection with a pull-only query model. Retaining `context` keeps the deprecated path alive and hands agents a way to avoid querying. Delete with the injection path. |
| `mode` param | Hybrid-vs-vector-vs-lexical is an optimization the caller cannot judge. Server-side. |
| `search` (as distinct action) | Merged into `recall`. Its filters (`type`, `files`, `project`) survive as `recall` params. |
| `delete` | Memory is append-only + supersede. Hard deletion is a compliance operation, not a builder action. Moves to admin. |
| `consolidate_knowledge` | Single-consumer admin op (weekly consolidation task). Moves to the `buildd` admin action set, alongside `manage_missions` and peers, where the token cost falls on admin callers only. |

---

## Open questions

**Auto-supersede at 0.94 is aggressive.** It silently replaces a prior entry on write. The conservative variant is conflict-always — never auto-merge, always return candidates. Costs a round trip on every near-duplicate but nothing disappears without a decision. Chosen: auto, because agents writing memories at task completion will not reliably handle a conflict response, and a silently-lost duplicate is cheaper than a polluted index. Revisit if merges prove lossy.

**`recall` may want to split.** Querying `scope: memory` (prior lessons) and `scope: code` (this workspace's codebase) are different intents with different mental models; folding them behind one `scope` param may relocate the `search`/`query_knowledge` confusion rather than remove it. Kept unified — one retrieval entry point is the point — but this is the weakest joint in the design.

---

## Migration

1. Ship `recall` and `learn` alongside `buildd_memory`. Both write to the same store — no data migration.
2. Update role/skill bodies to reference `recall` in the "before you start work" step. This is where the doctrine gets enforced; the tool description reinforces it but the role body is what agents read first.
3. Move `consolidate_knowledge` to the `buildd` admin surface. Repoint the weekly consolidation task.
4. Mark `buildd_memory` deprecated in its description. Leave it callable for one release.
5. Deduplicate the tool across the three MCP servers — one knowledge surface, not three.
6. Remove `buildd_memory`.

## Acceptance

- An agent given only the tool list reaches for `recall` before diagnosing, without a prompt instructing it to.
- Writing a near-duplicate memory is impossible via the normal path.
- No caller-visible parameter references corpus namespacing, embedding mode, or similarity thresholds.
- Builder-scoped token cost of the knowledge surface drops measurably versus `buildd_memory`.
