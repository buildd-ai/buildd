---
title: Local Tool Call Trace
status: draft
owner: max
last_verified: 2026-11-08
summary: The runner MUST keep a bounded, versioned, local-only trace of each tool call and its observed result, flag repeats after file changes, and send the platform only enum counts, never raw text.
domain: runners
surfaces: [apps/runner/src/tool-trace.ts, apps/runner/src/bash-classify.ts, apps/runner/src/tool-metrics.ts, apps/runner/src/workers.ts]
related: [runner-model-auth-source, model-comparison]
keywords: [tool trace, per-call trace, rg exit code, no matches, repeated search, result_observed, fingerprint, evidence gap, tool efficiency, tool-call-feedback-loop-spec]
verified_by: [apps/runner/__tests__/unit/tool-trace.test.ts]
supersedes: []
---

# Local Tool Call Trace

**Status note.** `draft`: the recorder, the worker wiring and the tests ship, but
the owner has not chosen the outcome spec this capability serves (task tokens
cannot select one; the filer does). Promote to `active` once that is done.

## Why this exists

Today a session leaves four partial records of its tool use:

| Record | What it keeps | What it cannot say |
|---|---|---|
| `recordToolCall` in `tool-metrics.ts` | count per tool name | order, arguments, results |
| `recordBashCommand` in `bash-classify.ts` | Bash bucket and search-pattern shape counts | whether the search found anything, whether it was repeated |
| `extractBuilddAction` in `action-events.ts` | buildd action name and time | everything else |
| `worker.toolCalls` (last 200) with `resultSignature` | recent calls with a result hash, in memory | a stable schema, exit semantics, change-awareness |

None joins a call to its result. So "did that search return nothing, and did the
agent run it again after the files changed?" cannot be answered, and the
efficiency questions behind it (wasted searches, unobserved results) are guessed
from proxies. This spec adds the missing per-call record, locally.

## Reconciliation with prior work

- **`tool-call-feedback-loop-spec` (task `0fc51366`).** That artifact specified a
  platform-side post-session rail, an analyser and a mid-session probe, all
  consuming the ordered tool-call sequence. Its recon found ordering the weak
  link: most sessions only had counts. This trace is the *producer* that spec
  assumed: it supplies ordered, result-joined calls. It is NOT the analyser, owns
  no experiment arm, and MUST NOT feed a prompt. Its hard boundary carries over:
  an observation record is never injectable state.
- **Post-session findings (`packages/core/post-session-findings.ts`,
  `apps/web/src/lib/post-session-findings.ts`).** Findings aggregate analyser
  output per signature with run-id-keyed idempotency. This trace is a different
  layer: raw material that stays on the machine. A future finding MAY be derived
  from `summarizeToolTrace()` counts; it MUST NOT receive trace events.
- **Retrieval-usefulness metrics.** Repeat detection is about *tool efficiency*.
  It is not a retrieval-usefulness or path-overlap proxy and MUST NOT be reused as
  one (that proxy was measured and rejected in the feedback-loop work).
- **Existing counters stay.** `toolCounts`, `bashCommandCounts` and the action
  events are unchanged and still sync as before; the trace adds no platform field.

## Capability statement

For every tool call a runner worker makes, the runner MUST be able to keep one
local record linking task, attempt, resolved model and config, harness, call id,
sequence number, tool category, elapsed time, outcome, exit code, output size,
truncation, and whether a result was seen, without changing what the agent sees
or does.

## Trace schema (version 1)

JSON Lines. First line a `header`, then `call` events, then a `summary` footer
on close (a resumed attempt appends another; readers take the last).

`header`: `v`, `taskId`, `attempt`, `workerId`, `harness` (`claude` | `codex` |
`unknown`), `model`, `config`, `salt`, `startedAt`.

`call`: `v`, `callId`, `seq`, `ts`, `tool`, `category`, `origin`, `shellBucket`,
`searchRole`, `elapsedMs`, `outcome`, `exitCode`, `exitCodeBasis`,
`resultObserved`, `output {bytes, lines, basis}`, `truncated`, `limit`, `denial`,
`scope {paths, options, patternShape, parse}`, `fingerprint`, `repeat {kind,
priorSeq, priorCount, priorOutcome}`, optional `excerpt`.

Vocabularies are exported as `TRACE_CATEGORIES` and `TRACE_OUTCOMES`. A reader
MUST ignore unknown fields and reject a higher `v` it does not know.

## Invariants

- **Local only.** Raw commands, queries, paths and results are never part of
  anything sent to the platform. The only sendable derivative is
  `summarizeToolTrace()`: enum counts and counters.
- **Observation only.** Recording never alters a prompt, a tool input, a
  permission decision or a result, and never throws into the worker loop.
- **Measured vs estimated is explicit.** Output size is `measured`, `estimated`
  (harness truncated it; a lower bound) or `absent`. Exit code is `structured`,
  `parsed_text`, `inferred` or `absent`. Bytes are never reported as tokens.
- **No confident misclassification.** A shell command the parser cannot trust
  (unbalanced quote, heredoc, process substitution, `eval`/`source`, variable as
  the binary, unrecognised binary, over 4000 characters) is category `unknown`.
- **Idempotent by call id.** A call id yields at most one `call` line, including
  across a resumed attempt that re-reads its own file.
- **Bounded.** Event count, bytes, pending calls, fingerprint table and retained
  files are all capped, and every drop is counted (`droppedByEventCap`,
  `droppedByByteCap`, `sampledOut`, `fingerprintEvictions`, `unobserved`).
  Repeat detection keeps running for calls whose events were dropped.
- **Private at rest.** Persistence is opt-in; directory `0700`, file `0600`.
  Excerpts are opt-in, redacted by the worker's redactor plus built-in token
  patterns, and length-bounded. Fingerprints are HMACs under a per-trace random
  salt, so they compare within one trace only.

## Result semantics

| Situation | Outcome |
|---|---|
| single `rg`/`grep`/`git grep`, exit 1 | `no_matches` |
| same, exit 2 or higher | `error` |
| failed call whose text says no such file / not a directory | `path_unavailable` |
| harness refused the call (`tool_result_meta.non_execution_kind`) | `denied`, `denial: policy` |
| failed call whose text says permission denied | `denied`, `denial: os` |
| exit 124 or "timed out" on a failed call | `timeout` |
| exit 130/143 or "interrupted"/"cancelled" on a failed call | `cancelled` |
| shell exit 0, empty output | `empty_output` |
| native Grep/Glob with no hits | `no_matches` |
| nonzero exit from a pipeline or chain | `nonzero_unmodeled` (exit semantics of one binary do not apply) |
| no `tool_result` seen by close | `unobserved`, `resultObserved: false` |

Text signals (denied, timeout, missing path) are trusted only on a failed call,
so a successful result that merely contains those words stays `ok`.

## Classification

Shell commands reuse `classifyBashSearch` for the dominant bucket. The trace adds:

- `searchRole`: `repo_search` when the bucket is `code_search`; `output_filter`
  when a grep-family segment sits downstream of a pipe in a command whose bucket
  is something else (`ps aux | grep bun`, `bun run test | grep fail`).
- Shell search scope: whitelisted flags (names only), repo-relative path
  operands, pattern shape, and `-m` limit. An unrecognised flag makes the parse
  `partial`; no pattern makes it `none`. A non-search shell call has no scope.
- Codex commands arrive as `Bash` tool_use (the adapter in
  `apps/runner/src/backends/codex-events.ts`); the command may be a string or an
  argv array such as `["bash","-lc","rg foo"]`, and both are read.

## Change-aware repetition

A fingerprint covers category, origin, search family, pattern, flags and scope
paths. A second call with the same fingerprint is a repeat: `repeat_unchanged` if
nothing in its scope was written since the first, `repeat_after_change`
otherwise. Writes that count: native Edit/Write/MultiEdit/NotebookEdit on a known
path (invalidates reads of that path and searches whose scope contains it or is
inside it); any shell file write or tree-rewriting git subcommand (`checkout`,
`switch`, `reset`, `restore`, `stash`, `pull`, `merge`, `rebase`, `apply`,
`cherry-pick`, `clean`, `revert`, `am`), which invalidates everything. A failed
or denied write invalidates nothing. A repo-wide search is invalidated by any
write.

## Acceptance criteria

- AC-1: GIVEN a single `rg` call WHEN its result is exit 1 THEN the event outcome is `no_matches`, and with exit 2 it is `error`.
- AC-2: GIVEN `ps aux | grep bun` WHEN classified THEN the category is `shell_other` and `searchRole` is `output_filter`, not `repo_search`.
- AC-3: GIVEN a command containing a heredoc, `eval`, a variable binary, an unbalanced quote, an unrecognised binary or more than 4000 characters WHEN classified THEN the category is `unknown`.
- AC-4: GIVEN a search then an Edit under the searched scope then the identical search WHEN traced THEN the second search has `repeat.kind` `repeat_after_change`; with an Edit elsewhere it is `repeat_unchanged`.
- AC-5: GIVEN a result the harness truncated WHEN traced THEN `truncated` is true and `output.basis` is `estimated`; with an image-only result `output.basis` is `absent` and bytes are null.
- AC-6: GIVEN a tool_use with no tool_result WHEN the trace closes THEN the event has `resultObserved: false`, outcome `unobserved` and `elapsedMs` null.
- AC-7: GIVEN excerpts not opted into WHEN a command contains a bearer token THEN no part of the token appears in any event; with excerpts on, tokens are redacted and the excerpt is at most the configured length.
- AC-8: GIVEN persistence is on WHEN a trace is written THEN the file mode is `0600`, the directory `0700`, and re-sending a call id (including after a restart) writes no second `call` line.
- AC-9: GIVEN more events than the caps allow WHEN capture continues THEN `recorded + droppedByEventCap + droppedByByteCap + sampledOut` accounts for every call and none is dropped silently.
- AC-10: GIVEN a closed trace WHEN `summarizeToolTrace()` is serialised THEN it contains no pattern text, path, fingerprint or excerpt.
- AC-11: GIVEN a call that fails to parse or a recorder that throws WHEN the worker handles the block THEN the worker loop is unaffected.

## Code surface

- `apps/runner/src/tool-trace.ts`: `ToolTraceRecorder`, `classifyShellForTrace`, `parseSearchArgs`, `deriveResult`, `summarizeToolTrace`, `pruneTraceDir`, `toolTraceConfigFromEnv`, `redactExcerpt`.
- `apps/runner/src/workers.ts`: creates the recorder on the first tool_use, feeds `onToolUse` and `onToolResult`, closes it at session cleanup.
- `apps/runner/src/bash-classify.ts`: `classifyBashSearch` (bucket and dominance rules).
- `apps/runner/src/tool-metrics.ts`, `apps/runner/src/action-events.ts`: the aggregate counters this record complements.
- `apps/runner/src/backends/codex-events.ts`: maps Codex events to the Claude-shaped blocks the recorder reads.
- Configuration: `BUILDD_TOOL_TRACE` (`off` | default in-memory), `BUILDD_TOOL_TRACE_DIR` (opt-in persistence), `BUILDD_TOOL_TRACE_EXCERPTS=1` (opt-in excerpts).

## Known gaps (stated, not hidden)

- **Codex successful commands emit no `tool_result`.** The adapter only
  synthesises a result for a failed command or MCP call. A successful Codex
  command is therefore `unobserved` with no exit code or output size. Closing
  this means emitting a result block from the adapter, which would also reach
  stuck detection and error-trace scanning; that is a behaviour change outside
  an observation-only task and needs its own decision.
- Claude Bash results carry no structured exit code; it is parsed from the
  "Exit code N" text when present, else inferred from `is_error`.
- Shell write paths are not parsed, so any shell write invalidates every
  fingerprint. This over-reports `repeat_after_change`, never under-reports it.
- Nothing consumes the trace yet. Uploading even the summary, and any link to the
  post-session findings ledger, is a separate task.

## Out of scope

- Any change to prompts, tools, hooks or permissions.
- Sending trace events, excerpts, fingerprints or paths to the platform.
- Token accounting (bytes are not tokens), cost, or model comparison.
- Native "hijack grep" interception or any steering of the agent.
- GPU load, the paused local-model eval task, and the benchmark suite.
