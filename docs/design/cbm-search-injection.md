---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "injector"
    type: "symbol"
    name: "CbmInjector"
    path: "apps/runner/src/cbm-injection.ts"
  - id: "graph-client"
    type: "symbol"
    name: "CbmGraphClient"
    path: "apps/runner/src/cbm-graph-client.ts"
  - id: "trigger-extraction"
    type: "symbol"
    name: "classifyBashSearch"
    path: "apps/runner/src/bash-classify.ts"
  - id: "decision"
    type: "symbol"
    name: "CBM_INJECTION_DECISION"
    path: "packages/core/cbm-injection-decision.ts"
  - id: "aggregate"
    type: "symbol"
    name: "aggregateCbmInjection"
    path: "apps/web/src/lib/cbm-insight.ts"
---
# CBM Search Injection: the graph answers the search the agent already ran

**Status:** Implemented (runner, decision route, analytics). Live from day one, no shadow phase.
**Related:** `apps/runner/src/bash-classify.ts`, `apps/runner/src/cbm-injection.ts`, `apps/runner/src/cbm-graph-client.ts`, `apps/runner/src/workers.ts`, `packages/core/cbm-injection.ts`, `packages/core/cbm-injection-decision.ts`, `apps/web/src/app/api/workers/[id]/cbm-injection/route.ts`, `apps/web/src/lib/cbm-insight.ts`, `apps/web/src/app/api/cbm/metrics/route.ts`, `docs/specs/codebase-memory-graph.md` (CBM-16..18), `docs/design/decision-calls.md`

---

## Problem

The codebase graph is mounted on every repo-backed Claude worker and agents
almost never call it. Graph tools are well under one percent of all tool calls,
and session-level adoption stayed flat after the index builds were fixed. So
health is not the constraint; habit is. Agents search the way they always have:
`rg`/`grep` through Bash (the most-called tool by a wide margin) and the `Grep`
tool. A text search for an identifier returns the lines that contain the word.
It cannot show a caller that reaches the symbol through a re-export or an alias,
and agents routinely scope a search to one directory and then edit a function
whose callers live elsewhere.

Prompt steering has been tried (`buildCbmSystemPromptBlock`). Waiting for the
agent to choose the graph is not working.

## Proposal

When an agent runs a search the graph can answer better, the runner queries the
graph itself, compares the graph's locations with the locations the search
already returned, and appends **only what the search missed** to that tool's
result. The agent's command runs unchanged. Nothing is hijacked, rewritten or
delayed before it runs.

### The crux

**Inject a deterministic set difference, never a model's opinion.** Everything
the agent sees is a `path:line` the graph holds and the search output did not
contain. A decision model (Jev) only chooses *which* factual list to show
(direct callers or the wider blast radius) or to show nothing; it never writes
text. If this is wrong — if the diff is mostly noise — the agent reads up to
three short, capped notes per session and ignores them, and the kill metric
below says so within one review cycle. If we instead let a model summarise, a
wrong summary is indistinguishable from a right one in the agent's context.

### Flow

1. **Trigger (deterministic).** After a tool result, in a `PostToolUse` hook,
   for Claude-backend workers with CBM `enforced`:
   - **Bash** whose command `classifyBashSearch` (the existing classifier in
     `bash-classify.ts`, same parser, same dominance rule) reports as
     `code_search` with an `identifier` shape;
   - **Grep** tool whose `pattern` has the `identifier` shape (same
     `shapeOfSearchPattern` rule).

   The symbol is the classifier's pattern token, returned only for the
   `identifier` shape and never stored. A symbol must match
   `^[A-Za-z_$][A-Za-z0-9_$]*$` and be at least four characters; shorter
   identifiers (`id`, `ok`) match too much to be worth a graph lookup.
   `regex`, `quoted_phrase`, `path_glob` and `unknown` shapes never trigger.

   *Not shipped:* the optional blast-radius trigger on the first Edit/Write to a
   file that exports symbols. It needs a "which symbols does this file export"
   query per edit, which is a second, larger latency budget; the
   `inject_impact` action below covers the same need for searched symbols.
   Listed under open questions.

2. **The runner queries the graph directly.** A runner-owned MCP stdio client
   (`CbmGraphClient`) speaks to its own `codebase-memory-mcp mcp` process
   against the session's cache dir (the shared seed, or the per-task index).
   Measured on a warm process: `search_graph` by exact name answers in well
   under a tenth of a second, `trace_path` faster still. The one-shot `cli`
   mode was measured too and costs seconds per call (process start-up and
   memory init), so it cannot meet the budget. A Cypher `query_graph` with a
   name filter scans and costs seconds even warm; it is not used.

   The client is started in the background when the session starts (never on
   the agent's critical path) and stopped at teardown. Until it has finished
   initialising, or until the session's project appears in `list_projects`
   (a per-task index that has not landed yet), every trigger records `no_index`
   and injects nothing.

   Per trigger, at most three calls: `search_graph name_pattern=^sym$`
   (definitions: file, line range, label), `trace_path direction=inbound`
   (callers; depth 1 for `inject_callers`, depth 3 for `inject_impact`, test
   files excluded by CBM's default), and one batched `search_graph` over the
   caller names to resolve each caller's file and line range. No graph hit →
   `not_in_graph`.

3. **Deterministic set diff.** The tool output is parsed for hits:
   `path:line:` (grep/rg `-n`), `path:line-` (context lines), and bare `path`
   or `path:text` (no line numbers: `rg -l`, `rg` without `-n`, Grep's
   `files_with_matches` mode). A graph location (file + line range) is
   **covered** when some hit names the same file (suffix match on path
   segments, so a search run from a subdirectory still matches) and either
   carries no line number or a line inside the range. A file-level hit
   therefore covers every location in that file: the diff errs toward
   silence. Covered locations are dropped. **Empty diff → `empty_diff`, no
   model call, nothing injected.** This is expected to be the common case and
   it costs two or three local graph calls.

4. **Jev only on a non-empty diff.** The runner posts structured facts to
   `POST /api/workers/[id]/cbm-injection`. The server owns the decision because
   `decisionCall` resolves the team's OpenRouter key and the runner has none.
   One Choice, `action`:

   | Label | Means | Not for |
   |---|---|---|
   | `inject_callers` | The missed locations are direct callers or the definition, and showing them helps the step the agent is on (finding usages, finding the definition). | A symbol the agent is about to change, where callers-of-callers matter. |
   | `inject_impact` | The agent is likely about to change this symbol (its file is in the task's declared scope or was already edited this session), so the transitive blast radius matters more than direct callers. | Read-only exploration. |
   | `skip` | The misses are unlikely to matter: a generic symbol, a broad survey that already returned many hits, or misses that are a tiny share of what the search showed. | A miss that is the only definition or the only caller. |

   **State is structured facts only:** task kind and category, whether a missed
   location is in the task's `pathManifest`, whether one was already edited this
   session, the search hit count and distinct files, the graph's definition
   and caller counts, the diff size, whether the definition itself was missed,
   and the symbol's graph label (`Function`, `Method`, …). Never the command,
   the pattern, the symbol name, file contents, paths or agent prose.

   Defined with `defineDecision` (`buildd.cbm_search_injection`, versioned,
   fingerprint pinned by a test), mode `gated` at `minConfidence` 0.6. Server
   deadline 900 ms; the runner aborts the request at 1 s. **On any error, a
   refusal (no key, capability off), a timeout or a below-threshold answer, the
   runner injects callers** and records `jev_error_injected` with the reason in
   the event's `jev.status`. Max chose live injection: the diff is factual and
   capped, so the fallback is to show it.

5. **Inject.** The hook returns `hookSpecificOutput.additionalContext`, which
   the SDK appends to that tool's result in the agent's context — next to the
   search it answers, not as a separate user turn. (The `inputStream.enqueue`
   nudge channel was the fallback; it is not needed.) Format, at most ~300
   tokens (1,200 characters, hard-truncated):

   ```
   [buildd code graph] 3 locations for `parseConfig` that this search did not show:
   - apps/api/src/server.ts:41 (caller: bootServer)
   - packages/core/load.ts:12 (caller: loadAll)
   - packages/core/config.ts:88 (definition, Function)
   ```

   At most eight entries; the rest is a count (`… and 4 more`). `inject_impact`
   adds the hop distance (`caller, 2 hops`).

### Limits (the safety property)

- **Never before the tool runs.** All work is in `PostToolUse`. The tool's
  own execution time is untouched.
- **Bounded added latency.** The hook resolves within **1.5 s** hard (graph
  450 ms, Jev 1 s), measured from the hook firing; past it the hook returns
  nothing and records `deadline_exceeded`. Typical cost: an `empty_diff`
  trigger adds a few hundred milliseconds at most; an injected one adds the
  graph calls plus one Jev round trip.
- **At most three injections per session**, and **never the same symbol
  twice** (`repeat_symbol`). After the third, triggers record `cap_reached`
  without querying anything.
- **Never fails a task.** Every graph or network error ends in a recorded
  outcome; the hook never throws.
- **CBM-16..18 unchanged.** The runner's own graph client is not an agent tool
  call: it never touches `cbmToolCounts`, `cbmFileAccessCounts` or `toolCounts`,
  so `toolCalls`, `totalCbmCalls`, `readCount`/`grepCount`/`globCount` and the
  adoption rate keep measuring the agent alone. A test pins this.
- **Codex: out of scope.** Codex has no post-tool hook seam. A Codex worker with
  CBM active records its identifier searches as `unsupported_backend` triggers,
  so the readout can size what is being missed, and never queries anything.
- **One off switch.** `BUILDD_CBM_INJECTION=0` (or `false`/`off`) on the runner
  disables it fleet-wide; the session records `enabled: false,
  disabledReason: 'kill_switch'`. Default on.
- **Cost.** One extra CBM process per Claude worker with CBM active. Its database
  pages are the same files the agent's server maps, so most of the memory is
  shared page cache; the process's own `CBM_MEM_BUDGET_MB` matches the agent's.

### Data: what is stored

No new table and no migration. `resultMeta.cbm.injection` (`CbmInjectionMetrics`,
`packages/core/cbm-injection.ts`), written at terminal state with the rest of
`resultMeta.cbm`:

- `enabled`, `disabledReason?` (`kill_switch` | `unsupported_backend`);
- `triggers` and `byOutcome` — exact counts, never truncated;
- `injections`, `nonEmptyDiff`, `graphAnswered`;
- `uptake: { window, tracked, taken }`;
- `events[]` — **one row per trigger** (first 50 kept; `eventsDropped` counts
  the rest): `trigger` (`bash` | `grep`), `outcome`, `hitCount`, `hitFiles`,
  `graphCount`, `diffSize`, `injectedCount`, `symbolKind`, `latencyMs` (hook
  start to return), and `jev: { label, confidence, status, latencyMs, version }`
  when Jev ran. `workerId` and `taskId` are the row the block lives on.

Outcomes: `no_index`, `not_in_graph`, `empty_diff`, `jev_skip`,
`injected_callers`, `injected_impact`, `jev_error_injected`, `cap_reached`,
`repeat_symbol`, `deadline_exceeded`, `unsupported_backend`.

**Privacy.** Same rule as `bash-classify.ts`: shapes, counts and labels only. No
command text, pattern text, symbol name, path or hash of any of them is
persisted. The symbol lives in memory for the length of one hook call plus the
per-session dedupe set.

**Uptake.** When a note is injected, the runner keeps an in-memory set of
SHA-256 digests of the injected repo-relative paths. Over the next ten tool
calls, a `Read`, `Edit`, `Write`, `MultiEdit` or `NotebookEdit` whose path
digests into the set marks that injection `taken` (once). Only the counts leave
the process.

**Why `resultMeta` and not a table.** Every CBM metric already lives there and is
read by one aggregation (`aggregateCbm`), so the injection numbers share the
cohort, window and auth of the numbers they will be compared with, and need no
migration on a day with concurrent schema work. A trigger row is a few dozen
bytes and the cap bounds a session to a few kilobytes. If per-trigger rows ever
need cross-session SQL (for example, joining Jev labels to uptake for an
offline eval), that is the time to promote `events` to a table.

**Read path:** `GET /api/cbm/metrics` returns an `injection` aggregate
(`aggregateCbmInjection`): sessions reporting, triggers, outcomes, eligible
triggers, `injectedRate`, `uptakeRate`, Jev label counts and fallback share,
and p50/p90 hook latency.

### Kill metric

Two rates, both from `/api/cbm/metrics` → `injection`:

- **Injected rate** = triggers with a non-empty diff ÷ eligible triggers
  (eligible excludes `cap_reached`, `repeat_symbol`, `unsupported_backend`).
  "How often does the graph know something the search missed?"
- **Uptake rate** = injections followed by a Read/Edit of an injected location
  within ten tool calls ÷ injections. "When it does, does the agent use it?"

If, after **N** sessions with at least one eligible trigger, the injected rate is
below **X** or the uptake rate is below **Y**, the graph is not earning its
place on the search path: turn injection off and stop investing in CBM
discoverability. Proposed defaults: N = 200, X = 10%, Y = 15% (open question 1).

## Open questions

1. **N, X and Y for the kill metric.** I lean 200 sessions, 10% injected, 15%
   uptake: 200 sessions is about a week of normal traffic and enough to read a
   rate to within a few points; 10% means one search in ten had a real miss;
   15% uptake is low enough that "the agent read it" is not just chance.
   Max's call.
2. **The 0.6 confidence gate.** Provisional, not from a held-out eval — there is
   no labelled data yet. Below it the runner injects callers (the live
   default). Once uptake data exists, the eval is "did the agent open an
   injected location" per label; re-tune and bump `promptVersion`.
3. **Edit-time blast-radius trigger.** Deferred (see Flow 1). Worth it only if
   `inject_impact` is chosen often and taken often.
4. **Injection cap of three.** Chosen to keep the worst case at about 900 tokens
   per session. Raise it if uptake is high and the cap is the common outcome.

## Non-goals

- Rewriting, blocking or delaying any agent command (no Bash hijack).
- Model-written text in the agent's context. Jev picks a list; it never writes one.
- Codex (no seam).
- Counting runner graph queries as agent CBM usage.
- A new table or migration.
