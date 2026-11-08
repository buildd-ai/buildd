---
title: Coding Evaluation Playground
status: draft
owner: max
last_verified: 2026-11-08
summary: The coding evaluation playground MUST extend the local replay harness with a versioned v2 suite of six case categories, hidden independent verifiers and admission gates, and report capability profiles, never a single winner.
domain: surfaces
surfaces: [packages/core/local-eval.ts, scripts/local-eval/cli.ts, eval/local-suite/v1/suite.json, docs/specs/model-comparison.md]
related: [model-comparison, model-inference-agent-capability, model-routing-and-tiers]
keywords: [coding eval, playground, local-suite v2, score-v2, harbor, terminal-bench, contextbench, repoqa, compaction, abstention, capability profile, cpuOnly]
verified_by: [packages/core/__tests__/local-eval.test.ts, scripts/local-eval/local-eval.test.ts]
supersedes: []
---

# Coding Evaluation Playground

**Capability statement**: A maintainer can run a fixed, versioned set of coding cases against local or hosted models, through the existing local-eval harness and the existing replay ingestion, and read a per-category capability profile with uncertainty. Nothing in it picks, routes or promotes a model.

Status is `draft`: the v2 suite, its scorer and its CLI commands are not built. Every mention of a v2 file or function below is a plan, not a fact. Build tasks are listed in "Per-task path manifest".

## 1. Relationship to what shipped (v0.395.2)

This extends, and does not replace:

- `packages/core/local-eval.ts` (suite validation, `scoreRun`, tamper and leak detection, `runToObservation`, `gpuGate`).
- `scripts/local-eval/` (`cli.ts`, `lib.ts`, `agent.ts`, `ollama.ts`).
- `eval/local-suite/v1/` (`suite.json`, `models.json`, `rubric.md`), scoring `score-v1`.
- `POST /api/model-observations/replay` and the `replay` block of `docs/specs/model-comparison.md`.
- `docs/local-model-evaluation.md` (runbook), `docs/local-ollama-runner.md`.

Rules:

- v1 cases, `suite.json` bytes and `score-v1` behaviour MUST stay byte-identical. v2 is a new directory `eval/local-suite/v2/` with its own `suiteVersion: v2` and `scoringVersion: score-v2`. A v2 run MUST NOT be scored by `score-v1`, and ingestion MUST reject a run whose `scoringVersion` does not match its suite.
- No second storage. Runs are `RunRecord`s ingested as controlled-replay observations; v2 adds optional fields, never a table.
- The shared mission surfaces are named in section 12 so that other missions do not duplicate them.

## 2. Source verification (fetched 2026-11-08)

Only what a fetched primary page stated is recorded. No model score from any source is used anywhere in this spec.

| Source | URL | Verified | Unverified or not stated |
|---|---|---|---|
| Harbor | https://docs.harborframework.com (`/tasks/overview.md`, `/agents/atif.md`, `llms.txt`) | A task is a directory: `instruction.md`, `task.toml`, `environment/` (Dockerfile or any spec the consumer supports; Dockerfile, docker-compose, Apptainer cited), `solution/solve.sh`, `tests/test.sh`. The verifier is `tests/test.sh`, runs after the agent in the same environment and writes `/logs/verifier/reward.txt` (or `reward.json` for labelled rewards). Multi-step tasks use `steps/step-N/`. ATIF (Agent Trajectory Interchange Format), v1.8 current, saved as `trajectory.json`: agent, ordered steps, tool calls, observations, per-step metrics. Pages exist for artifacts, pre-integrated agents, custom agents, registries. | How environments are pinned or versioned (not described); how `solution/` is used by the trial; the exact field that carries reasoning in ATIF; any licence. |
| Terminal-Bench | https://www.tbench.ai | The site shows **Terminal-Bench 4.0** as current, with tasks hosted on the Harbor hub and a repository under `harbor-framework`. This spec never calls 2.0 the latest. | Task format and licence (not on the page); task count. |
| SWE-Bench Pro V2 | https://labs.scale.com/blog/swe-bench-pro-v2 (post dated 2026-09-22) and arXiv 2610.24206 (submitted 2026-10-16, CC BY 4.0 paper) | Revised public split; audits, expert review and blind re-implementation repaired or retired many original tasks; hardened protocol limits model network access to the model endpoint and re-grades every patch in a clean container. | The blog body (only the preview was readable); the dataset licence (the arXiv page links a Hugging Face dataset without stating one). A search snippet cited release notes on GitHub with a different task count than the paper; that was not reconciled, so no count is used. |
| ContextBench | https://contextbench.github.io, arXiv 2602.05892 (2026-02-05, v3 2026-02-11) | Scores the retrieval process, not only task success: line-level context recall, precision and efficiency against human-annotated gold contexts, on 1,136 issue tasks, 66 repos, 8 languages. Reports that agents favour recall over precision and that retrieved context is often not used in the final solution. | Dataset licence (not stated). |
| RepoQA | arXiv 2406.06025 (2024-06-10) | Searching Needle Function: find a function in a long code context from a natural-language description; 500 tasks, 50 repos, 5 languages. | Licence of the data (only arXiv's distribution licence is shown). |
| CompactionBench | https://www.microsoft.com/en-us/research/publication/benchmarking-long-horizon-agent-context-compaction-with-compactionbench/ ; PDF `.../wp-content/uploads/2026/10/CompactionBench_preprint.pdf` | Microsoft Research preprint, October 2026: persistent multi-turn coding sessions for repeated compaction; compaction is rare in production sessions but a large share of tokens. | The PDF body was **not** read (only the landing page); no arXiv id found; no data or licence statement. Do not confuse with the unrelated `compactbench` project or arXiv 2610.31710 (Compact-Bench). |

**Licence gate**: no task, instruction, test or trajectory from any source above MAY be imported into `eval/` until its licence is read from the source repository or dataset card and recorded in the case's provenance. At the time of writing none of the six has a verified data licence in this table, so initial v2 cases are authored in this repository or derived from this repository's own code. They borrow design ideas only.

### What the sources change in our design

- ContextBench's finding that explored context is often unused, plus our own earlier falsified result (file-level overlap between what an agent opened and what the reference changed was a proxy for retrieval quality; it was not usefulness or correctness), means: **file overlap MUST NOT be a score, a gate or a reported quality metric**. Retrieval is reported only as a diagnostic (what was opened, what was cited in an observable claim), and a case passes on verified outcome alone.
- SWE-Bench Pro V2's hardening (offline except the model endpoint, clean-container re-grade) matches our existing isolation and is kept as the isolation baseline.
- Harbor's layout (instruction, environment, reference solution, separate verifier) is the closest published shape to our manifest.

## 3. Harbor adapter decision

**Decision: build a thin export adapter (v2 case to a Harbor task directory) only after the six-category suite runs; do not build an import adapter now; do not adopt Harbor as the runner.**

Reasons:

- Our manifest (section 4) already has the same five parts as a Harbor task, so export is a mechanical mapping, and it makes our cases runnable on other harnesses for an independent check of our scorer.
- Import is blocked by the licence gate (section 2) and by unverified pinning semantics; imported tasks would also bring Docker, which the local replay harness deliberately does not need (Bun only, no network).
- Harbor needs container sandboxes; a second runner and second result store would compete with the shipped harness, which this task forbids.
- Terminal-Bench 4.0 tasks live on the Harbor hub. Running them is a separate, later decision, taken only if a licence check passes; it is not part of this spec.
- Trajectories: our run record keeps what the harness observes. Mapping it to ATIF is part of the export adapter and is optional.

Revisit when: a second harness is needed for scorer cross-checks, or a source's licence is verified.

## 4. Case manifest

A v2 case is a directory `eval/local-suite/v2/cases/<caseId>/` with a `case.json` manifest and the files it names. Fields:

| Field | Rule |
|---|---|
| `id`, `version`, `contentHash` | Immutable. `contentHash` is a SHA-256 over the canonical bytes of every file the case names (snapshot, instruction, verifier, reference, rubric). Any edit makes a new `version`; the old version stays in history so earlier runs remain interpretable. |
| `category` | One of the six in section 5. |
| `snapshot` | The repo snapshot the agent receives: a pinned commit of this repository, or a vendored fixture tree under the case directory, delivered as one commit with no remote and no history. |
| `instruction` | The only task text the agent sees. |
| `reference` | A reference solution (patch, or answer, or `abstain`) kept outside the agent tree. |
| `verifier` | A hidden, independent verifier: hidden tests, or a rubric with graders (section 7). It never reads the reference solution and is never inside the agent tree. |
| `deps` | Toolchain and packages, pinned. |
| `resources` | `cpuOnly: boolean`, `estimatedVramMb: number or null`, `estimatedRamMb`, `wallClockSeconds`, `maxTurns`, `toolBudget`. A case that needs no inference to be verified sets `cpuOnly: true`. `cpuOnly` describes the case's own tooling; it never permits a model run. |
| `labels` | `difficulty` (easy, medium, hard) and `skills` (free tags from a closed list in the suite). |
| `provenance`, `contamination` | Where the code came from, its licence, and whether public history may be in a model's training data. Authored fixtures state "authored for this suite, not published before <date>". |
| `admission` | The evidence from section 6, with toolchain and date. |
| `expected` | Either an expected answer (observable: file and symbol, or behaviour) or `abstain` with the audited search scope (section 6, gate 4). |

A manifest with a missing field, an unknown category or a stale `contentHash` is rejected by `validate`.

## 5. Categories and cases

Six categories, at least four cases each (24 minimum), each with at least one case that exposes an incorrect absence or success conclusion. Case ids below are the build task's targets; they are not yet files.

1. **find-by-behaviour**: locate the code responsible for a described behaviour, with no identifier in the question. Includes ambiguity (two plausible sites; the answer must name both and say which is live) and answer-absent (the behaviour is not implemented; correct answer is abstention). Exposing case: a decoy that matches by name but never runs, where "found it" is wrong.
2. **causal-debugging**: a failing repro, with distractors (a recent unrelated change, a flaky-looking test). Exposing case: the visible failure is a symptom and patching it turns the repro green while the cause remains, caught by a second hidden check.
3. **multi-file-change**: implement or refactor across at least three files with hidden tests. Exposing case: a change that passes the visible suite but breaks a caller the hidden tests cover.
4. **code-review**: diffs with seeded or real defects and clean controls. Exposing case: a clean control the agent must pass with no finding, so "found something" is wrong.
5. **long-context-requirements**: requirements dispersed across files and notes, some superseded, some in conflict, one question unanswerable. Exposing case: a superseded requirement that a model follows.
6. **terminal-recovery-compaction**: a terminal task interrupted and resumed, and a session compacted in stages. Exposing case: a constraint stated early that a compacted summary drops, with the work still "succeeding" on the visible tests.

Answer-absent and abstention cases exist in categories 1, 4 and 5 at least. An agent that fabricates an answer fails; an agent that abstains on an answerable case fails.

## 6. Admission gates

A case is admitted only when all hold, with the evidence recorded in `admission`:

1. **Reference passes**: the verifier passes the reference solution on the snapshot.
2. **Negative control fails**: the verifier fails the unmodified snapshot and at least one named broken candidate (a plausible wrong patch or wrong answer; two for the exposing cases).
3. **Independent of the patch**: no exact-patch or exact-string match to the reference. Any other correct solution passes. Admission includes one alternative correct solution, written by someone other than the reference author, that the verifier passes.
4. **Absence audited**: an answer-absent case records the entire search scope (every file the snapshot contains, the dependency tree, generated files, config, docs, and the identifiers and the behavioural keywords searched), the audit method, and the auditor. A grep for one name is not an audit. A second person confirms before admission.
5. **Isolation holds**: a probe agent tree contains none of the hidden verifier, reference, history, suite files or later commits (the shipped `leakFindings` check, extended for v2 files).
6. **Deterministic**: the verifier gives the same result on three consecutive runs on the pinned toolchain.

A rejected case is kept with its failing evidence, as `build-complete-predicate` is in v1, to show the gate works.

## 7. Scoring (`score-v2`)

- **Pass** needs the hidden verifier green, visible checks green, no tampering, no leak. Result states stay `pass | fail | invalid | error | unscored`.
- **Error separation**: every non-pass run carries a `failureClass` of `model`, `harness` or `infra`. `harness` and `infra` outcomes (adapter bug, Ollama unreachable, out of memory, timeout of the host) are `error` and excluded from model pass rates, reported as counts beside them.
- **Code review** scores true findings (matched to seeded or confirmed defects by location and described cause, not wording) and false positives (findings on clean code or on no defect). Report precision and recall per case, and the false-positive rate on clean controls. Graders are calibrated before use: at least two independent graders (a model other than the model under test, and a person on a sample) score a calibration set with known answers; agreement and disagreement cases are stored; a grader below the recorded agreement threshold is not used. A grader MUST NOT be the model under test.
- **Reasoning** is scored only from observable causal claims: each claim names a file, symbol or behaviour that a check can confirm, and a verifiable repro (a command and the output it must give). Hidden chain-of-thought is never requested, stored or scored.
- **Abstention**: a correct abstention on an answer-absent case is a pass; a made-up answer is a fail with `fabrication` noted.
- **Unknown is unknown.** An unmeasured metric (tokens, VRAM) is null, never zero.

## 8. Isolation

The agent sees the instruction and the snapshot as one commit with no remote. Hidden tests, reference, rubric, graders' notes, suite files and later history are outside it and are injected, or run from outside, after the agent stops. Network is off except the model endpoint. The runner restores test-runner files before grading (as v1). Any edit that disables, deletes or weakens a test, or any read of hidden material, makes the run `invalid`.

## 9. Long context and compaction tracks

- **Fixed evidence sizes**: 8K, 16K and 32K tokens of evidence, built from the same material, with the relevant evidence at varied, recorded positions (start, middle, end, and dispersed). Actual token counts are measured with the model's own tokenizer and stored in the run; the target size is a label, not a measurement.
- **Two tracks per case, reported separately**: *single-context* (all evidence in the prompt) and *tool-retrieval* (evidence in the tree, found with the tools under the fixed tool budget). A case run in both gives paired results on the same case.
- **Overflow and truncation are explicit**: if the input exceeds the loaded context, the run records `overflow` with the actual counts and is `error` with `failureClass: infra`, never silently truncated or scored as a model failure. Truncation by the adapter is recorded as `truncated: true` with tokens dropped.
- **No claim beyond what ran.** No 128K claim is made for a 24 GB GPU or any other hardware. 32K is the ceiling of this spec, and a larger size needs its own measured admission.
- **Compaction track**: a session is split into stages. After each stage (stage 0 = before compaction), the run is checked for the constraints stated earlier and the tests, recorded as a vector of constraint and test results per stage. A result that is green at the end while a constraint failed at a stage is recorded as `constraint_dropped`, not as a clean pass. Compaction is done by the harness's own mechanism or a fixed summariser, named in the run, as a treatment.

## 10. Adapters, budgets and treatments

- Each model adapter declares its capabilities (tool calling, context length, system prompt, structured output). A case that needs an unsupported capability is recorded `unsupported: <capability>` for that model. The adapter MUST NOT silently change the case, drop a tool, shorten the prompt or relax a test to make a model fit.
- Tool budgets (calls, turns, wall clock) and the harness version are fixed in the suite and recorded in each run. The harness (Claude Code, other) and the retrieval policy (none, grep tools, an index) are **separate treatments**: a comparison varies one, and a result names both. Mixing a harness change with a model change in one comparison is not reported as a model effect.
- A run records the `harness` name and version (already in `RunRecord`), plus `retrievalPolicy`, `track` and `toolBudget` as new optional fields.

## 11. Reporting

- A **capability profile** per configuration: pass rate with Wilson interval per category and per skill label, abstention accuracy, review precision, recall and false-positive rate, per-stage constraint retention. There is no single winner, composite score or rank, and `autoPromote` stays false.
- **Repeats**: at least 3 trials per case and configuration (as v1); the variance across trials is shown.
- **Paired comparisons**: two configurations compared on the same cases, with a paired interval; below the shipped minimum samples the answer is `insufficient_n` (reuse `MIN_RESOLVED` and `MIN_DISCORDANT_PAIRS` in `packages/core/model-comparison.ts`).
- **Splits**: `dev` (open, used to build and tune), `sealed-holdout` (hashes published, content withheld, run only for a decision and then rotated into dev), `prospective` (cases authored after the models were fixed). Results are reported per split and never pooled. A model's performance on dev MUST NOT be reported as holdout.
- **Cost and speed**: latency, input and output tokens, peak VRAM with its sample count, as in v1 (VRAM is a machine-level upper bound).
- Public history in a model's training data is a stated contamination limit on all replayed cases.

## 12. GPU, workers and shared surfaces

- **No accidental inference.** A worker MUST NOT start a model run unless the case is `cpuOnly: false` and the gate passes. `validate`, `admit` (verifier checks against the reference and controls) and unit tests are `cpuOnly` and need no model. The `gpu-check` gate and the digest check stay mandatory (`gpuGate`, `digestCheck`). Cases carry `estimatedVramMb` so the gate can refuse before loading.
- **GPU runs are deferred until 09:00 America/New_York on 2026-11-08.** Before that, build tasks ship code, cases and admission evidence only. The runbook (`docs/local-model-evaluation.md`) gains a v2 section; v1 text is unchanged.
- **Shared surfaces, named so they are not duplicated.**
  - Mission f885b126 (local tool tracking): owns how a local session's tool calls are recorded. This spec consumes tool-call counts as an input to `toolBudget` and does not add a second tool-call recorder.
  - Mission 8842e434 (local benchmark): owns local benchmark runs of its own. This spec shares `RunRecord`, the replay ingestion route and `docs/local-model-evaluation.md` with it. Any new field is added to `RunRecord` once, optional, and announced in that mission before merging.
  - Both share `packages/core/local-eval.ts`, `scripts/local-eval/` and `docs/specs/model-comparison.md`. A change to one of these files in a v2 task MUST rebase on the other mission's latest merge; the v1 byte-identity test is the guard.

  The two missions' own task lists were not read when this was written; if either already owns a path in the manifest below, that task defers to it.

## 13. Privacy, redaction, retention

- This repository is public: no production data, row counts, UUIDs, handles or private repository names in any case, fixture, comment or doc. Snapshots are this repository's public code or authored fixtures. `bun run no-prod-data:check` MUST pass.
- Run records and trajectories store paths, commands and model outputs only. Credentials, auth files, environment values and the machine's user paths are redacted before writing (the harness uses an empty per-run config dir). A run that would store a secret-shaped string is `invalid` and not written.
- Retention: raw trajectories stay on the evaluating machine and are deleted after 30 days; the run record (no transcript) is what is ingested and kept. Sealed-holdout content is never in the repository, only its hash.

## Invariants

- v1 `suite.json` and `score-v1` are unchanged; v2 has its own suite version and scoring version.
- A case is admitted only with evidence for all six gates.
- The agent tree never contains hidden verifier, reference, rubric or history.
- File overlap is never a score or a gate.
- No chain-of-thought is requested, stored or scored.
- An unsupported capability is reported, never worked around silently.
- Harness errors and infra errors never count as model failures.
- No page, API or report names a single winner or promotes a model.
- No model run starts before the GPU window, or for a `cpuOnly` verification.

## Acceptance criteria

- AC-1: GIVEN the v2 suite is added WHEN `eval/local-suite/v1/suite.json` is hashed THEN it equals its pre-change hash, and the v1 test suite passes with `score-v1`.
- AC-2: GIVEN a v2 case whose `contentHash` does not match its files WHEN `validate` runs THEN it rejects the suite naming the case.
- AC-3: GIVEN a case whose verifier passes the unmodified snapshot WHEN admission runs THEN the case is not admitted.
- AC-4: GIVEN a case whose broken candidate passes the verifier WHEN admission runs THEN the case is not admitted.
- AC-5: GIVEN an answer-absent case with no recorded search scope or no second confirmer WHEN admission runs THEN it is not admitted.
- AC-6: GIVEN a different correct solution to a case WHEN graded THEN it passes; and a patch textually equal to the reference is not required.
- AC-7: GIVEN the suite WHEN counted THEN each of the six categories has at least four admitted cases and at least one exposing case.
- AC-8: GIVEN a probe agent tree for any case WHEN scanned THEN it contains no hidden verifier, reference, rubric or later history.
- AC-9: GIVEN a code-review case with a clean control and an agent that reports a finding on it THEN the finding counts as a false positive and is reported in the false-positive rate.
- AC-10: GIVEN a grader that is the model under test WHEN a review is graded THEN the grading is refused.
- AC-11: GIVEN an answer-absent case and an agent that names a file THEN the run fails with `fabrication`; and an abstention passes.
- AC-12: GIVEN a long-context run whose input exceeds the loaded context WHEN recorded THEN it is `error` with `failureClass: infra` and an `overflow` record with actual token counts, and no truncation is applied silently.
- AC-13: GIVEN a compaction run where a stage-1 constraint fails and the final tests pass THEN the result is marked `constraint_dropped`, not a clean pass.
- AC-14: GIVEN a model adapter lacking a capability a case needs WHEN run THEN the record is `unsupported: <capability>`, and the case text and tools are unchanged.
- AC-15: GIVEN a `cpuOnly: false` case and no passing GPU gate WHEN a run is requested THEN no model is loaded and the command exits non-zero.
- AC-16: GIVEN dev and sealed-holdout runs of one configuration WHEN reported THEN they appear in separate rows and are never pooled.
- AC-17: GIVEN fewer resolved runs than `MIN_RESOLVED` WHEN a paired comparison is requested THEN the verdict is `insufficient_n`.
- AC-18: GIVEN a v2 run ingested with a v1 `scoringVersion` or the reverse THEN the route rejects it with HTTP 400 and writes nothing.
- AC-19: GIVEN any v2 file WHEN `bun run no-prod-data:check` runs THEN it passes.
- AC-20: GIVEN retrieval overlap data for a run WHEN the report is built THEN it appears only as a diagnostic and feeds no pass rate or ranking.

## Per-task path manifest

Each build task owns only its listed paths. Tasks later in the list depend on earlier ones. All paths are new unless marked (edit).

| # | Task | Paths | Notes |
|---|---|---|---|
| 1 | Core types and `score-v2` | `packages/core/local-eval-v2.ts`, `packages/core/__tests__/local-eval-v2.test.ts`; (edit) `packages/core/local-eval.ts` only to export shared helpers | Manifest type, `contentHash`, `validateSuiteV2`, `scoreRunV2`, failure classes. No change to `score-v1` behaviour. |
| 2 | Harness commands | `scripts/local-eval/v2.ts`, `scripts/local-eval/v2.test.ts`; (edit) `scripts/local-eval/cli.ts` to add `admit`, `validate --suite v2`, `run --suite v2` | `cpuOnly` gating, adapter capability declarations, token counting, overflow record. |
| 3 | Suite scaffolding and admission harness | `eval/local-suite/v2/suite.json`, `eval/local-suite/v2/README.md`, `eval/local-suite/v2/cases/_template/`, `eval/local-suite/v2/admission.md` | Empty of cases except the template; byte-identity test for v1. |
| 4 | Cases: find-by-behaviour, causal-debugging | `eval/local-suite/v2/cases/find-*/`, `eval/local-suite/v2/cases/debug-*/` | 4+ each, with exposing cases and absence-audit records. |
| 5 | Cases: multi-file change, code review | `eval/local-suite/v2/cases/change-*/`, `eval/local-suite/v2/cases/review-*/`, `eval/local-suite/v2/review-calibration/` | Seeded defects, clean controls, calibration set. |
| 6 | Cases: long context, terminal and compaction | `eval/local-suite/v2/cases/ctx-*/`, `eval/local-suite/v2/cases/term-*/` | 8K/16K/32K evidence, positions, stage checks. |
| 7 | Ingestion and reporting | (edit) `apps/web/src/app/api/model-observations/replay/route.ts` and its `route.test.ts`; (edit) `packages/core/model-comparison.ts` and its test; (edit) `apps/web/src/app/app/(protected)/settings/models/comparison/` | Optional v2 fields, version check (AC-18), capability profile, split separation. Shared with missions f885b126 and 8842e434: coordinate before editing. |
| 8 | Runbook and Harbor export | `docs/local-model-evaluation.md` (v2 section), `scripts/local-eval/harbor-export.ts` and test | Export only, after tasks 1-6; no import. |
| 9 | Spec promotion | this file | Set `status: active` and `verified_by` to the v2 tests once tasks 1-7 land; run `bun run specs:check`. |

## Code surface

- `packages/core/local-eval.ts` (shipped): `scoreRun`, `detectTestTampering`, `leakFindings`, `gpuGate`, `digestCheck`, `runToObservation`.
- `scripts/local-eval/` (shipped): `cli.ts`, `lib.ts`, `agent.ts`, `ollama.ts`.
- `eval/local-suite/v1/` (shipped, frozen).
- `packages/core/model-comparison.ts` (shipped): `MIN_RESOLVED`, `MIN_DISCORDANT_PAIRS`, `buildReplayComparison`.
- `docs/specs/model-comparison.md`, `docs/local-model-evaluation.md`, `docs/local-ollama-runner.md`.
- Planned, not yet present: the files in the manifest above.

## Out of scope

Choosing or promoting a model; routing changes; importing third-party tasks; running Harbor or Terminal-Bench as our runner; any claim of a model's score, of 128K context on 24 GB, or of a result before a measured run; hidden chain-of-thought evaluation; production-data evaluation (covered by `model-comparison`).
