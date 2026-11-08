# Local model replay evaluation: runbook

Controlled comparison of local Ollama models on **replayed past fixes** of this
repository. Rules: `packages/core/local-eval.ts`. Harness: `scripts/local-eval/`.
Suite: `eval/local-suite/v1/` (`suite.json`, `models.json`, `rubric.md`).
Results land in the model comparison under `replay`
(`docs/specs/model-comparison.md`).

## Status: the GPU benchmark has NOT been run

Nothing in this change ran a model. The worker that wrote it had no GPU and no
Ollama. What was run and verified there: the suite's admission (each admitted
case's hidden regression fails on the pre-fix tree and passes on the reference
fix, on a Linux host with Bun), the grading-isolation and tamper checks on a
real export, and the pure scoring, GPU-gate and ingestion rules.

Earlier smoke results (Gemma through Claude Code and Codex succeeded; a Mistral
model failed) show only that the harness can start a session on those tags.
They are compatibility evidence, not quality evidence, and feed no figure here.
Every number the benchmark will produce is unknown until you run it.

## What a case is

Four public fixes: three admitted, one rejected and kept as proof the gate
works (`build-complete-predicate`: its added tests already passed before the
fix). Per case the suite records the pre-fix SHA, the fix SHA, hidden and
visible tests, setup needs (Bun only, no network, no credentials), expected
behaviour, a contamination note and the admission result. These are public
commits: a model may have seen the fix. Replay results are not an
uncontaminated generalisation claim. Add fresh and private cases in a later
suite version. Multi-file work, tool-use and review cases come after the
historical bug fixes, as a later suite version.

## What the agent sees

The problem text and a `git archive` of the pre-fix SHA, re-initialised as one
commit with no remote. No fix commit, no later history, no hidden tests, no
reference patch, no suite files. Hidden tests are copied in from the source
repo after the agent stops. The test-runner files (`bunfig.toml` and the unit
test runner script) are restored from the pre-fix SHA before grading.
Prompt, turn budget (40), wall clock (30 min), context policy and trials (3)
are identical for every model. Scoring is `score-v1`: pass needs the hidden
regression and the visible tests green, no tampering, no leak. Any other correct
fix passes; patch equality is never checked.

## WSL runbook

Isolated source, config and runner names are fixed. Do not touch the shared
runner, your own edits, default routing or the workspace executor.

```bash
# 0. Isolated source checkout of this branch (never your working copy)
git clone --no-hardlinks <repo-url> /home/administrator/.buildd-ollama-source
cd /home/administrator/.buildd-ollama-source && git checkout buildd/32c1a249-feat-models-versioned-local-co
bun install

# 1. Dedicated Ollama on its own port, one model at a time, context set per pass
export OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1
OLLAMA_CONTEXT_LENGTH=16384 ollama serve &      # note the PID; stop it with kill <pid>

# 2. Verify tags exist and record digests (pull only what is missing)
for t in gemma4:26b qwen3-coder:30b qwen3.5:27b; do ollama list | grep -F "$t" || echo "MISSING $t"; done
curl -s 127.0.0.1:11435/api/tags | jq '.models[] | {name, digest}'

# 3. Suite sanity and GPU gate
bun run scripts/local-eval/cli.ts validate
bun run scripts/local-eval/cli.ts gpu-check --origin http://127.0.0.1:11435

# 4. Runs: 16K first, restart the server with OLLAMA_CONTEXT_LENGTH=32768 for the 32K pass
S=/home/administrator/.buildd-ollama-source
bun run scripts/local-eval/cli.ts run --model gemma4:26b --context 16384 \
  --source $S --deps-from $S --out /home/administrator/.buildd-ollama-local/runs
# then qwen3-coder:30b, qwen3.5:27b; devstral-small-2:24b and glm-4.7-flash later

# 5. Independent review, same reviewer and rubric (eval/local-suite/v1/rubric.md) for every run
bun run scripts/local-eval/cli.ts review --run <runs>/<runId>/run.json --verdict approved --rounds 0 --reviewer <fixed-reviewer-id>

# 6. Ingest (BUILDD_API_KEY of the workspace's account)
bun run scripts/local-eval/cli.ts ingest --dir /home/administrator/.buildd-ollama-local/runs --workspace <workspace-id>
```

`run` refuses to start when: the tag is not pulled; the digest differs from
`models.json`; the GPU cannot be read; another model is loaded; free memory is
under `LOCAL_EVAL_MIN_FREE_MB` (default 20000); or the loaded context differs
from the requested one. It unloads the model when it finishes. Digests in
`models.json` stay `null` until you copy a first observed value in a reviewed
commit; the run record always stores the observed digest and quantization.

Tags (`gemma4:26b`, `qwen3-coder:30b`, `qwen3.5:27b`, `devstral-small-2:24b`,
`glm-4.7-flash`) are the ones the owner named. They were not verified against
the Ollama library or your machine: step 2 does that.

### The `local-ollama-smoke` runner

Keep the isolated runner named `local-ollama-smoke`, with its config under
`/home/administrator/.buildd-ollama-local` and its model env as in
`docs/local-ollama-runner.md`, for the smoke script only. The harness above does
not use a runner: it drives Claude Code directly with an empty per-run config
dir, so no real credential or memory is read.

## Recorded per run

Correctness (hidden + visible), review verdict and rework rounds, CI-equivalent
(visible tests), wall time, input and output tokens when Claude Code reports
them, turns, peak VRAM (bounded `nvidia-smi` sampling, a machine-level upper
bound) and its sample count. Anything not measured is stored as unknown.
Cost is unpriced (local), not zero.

## Local executor task and API pinning

The evaluation task is meant to be claimed **interactively** by a person's
local session, which is what makes it a local executor. Pinning a task to a
runner (`runner` on `create_task`) only routes it to that machine's runner
process; it does not make the work local-executor work, and the API cannot pin
"interactive claim only". The task therefore states the commands and asks for a
local session; nothing enforces it server-side.

## v2 suite runbook (coding evaluation playground)

Contract: `docs/specs/coding-eval-playground.md`. Cases: `eval/local-suite/v2/`.
Rules: `packages/core/local-eval-v2.ts` and `local-eval-v2-ops.ts`. The v1 text above is unchanged and v1 runs stay in
the readout, as a separate block.

### Status: no v2 scores exist

**No model has been run against the v2 suite, so there are no scores.** What exists and was verified without a
model: case admission evidence (the hidden verifier passes the reference, fails the negative controls and agrees on an
alternative solution), the pure graders, ingest validation, the per-category aggregation, redaction, and the executor:
every one of the 21 dev cases, in all six categories, runs end to end through `run` with the deterministic `fixture`
adapter (no model) and is graded by its hidden verifier, and the real Claude Code CLI runs through the executor against
a mock Anthropic endpoint on loopback (no model). Those are checks of the harness, not results.

`cpuOnly` in a case says its verifier needs no inference; it does not decide whether a model may run. A model run is
admitted by the tag, digest and GPU checks below, for any case.

Sealed-holdout cases are descriptors and hashes here. They are runnable only with `--sealed-root <dir>` pointing at
content held outside the repository whose recomputed hash matches `splits.json`; otherwise they are listed as
unavailable and never scored.

### Before a model run

- The tag is listed in `eval/local-suite/v2/models.json` (separate from v1's). `digest: null` means not yet observed:
  the first run records it in every run record; pin it in `models.json` after that run. A changed digest is refused,
  and the digest is re-read before every trial.
- VRAM: the run needs the larger of the model's figure (`estimatedVramMb` in `models.json`, else `--vram-mb`, else
  `LOCAL_EVAL_MIN_FREE_MB`, default 20000) and the case's own `estimatedVramMb`. The run prints which figure it used.
- Ollama on loopback with nothing loaded, started with `OLLAMA_CONTEXT_LENGTH` equal to `--context` (the load fails
  otherwise). The run loads the model once, runs every trial, and unloads it. It does not change Ollama's settings.

### Harness treatment

v2 runs use a fixed treatment, `claude-code-minimal-v1` (`HARNESS_TREATMENT_V2`): a short replacement system prompt,
exactly the tools Read, Edit, Write, Glob, Grep and Bash, `--strict-mcp-config` with an empty MCP config,
`--setting-sources ''`, `stream-json` output, an empty per-run config dir and the prompt on stdin. Claude Code's default
system prompt and tool set do not fit a 16K window; this one leaves room. A prompt whose estimate (including a 6144-token
allowance for tool schemas and the reply) does not fit `--context` is recorded `overflow` and the agent is not started.
At `--context 8192` the long-context cases therefore record overflow: their smallest evidence set is 8K. What the
harness cannot measure (schema tokens, Ollama truncation, the model tokenizer, mid-run tool budget) is listed in each
run's `execution.json` as unknown.

### Commands (all `bun run scripts/local-eval/cli.ts <command> --suite v2 ...`)

| Command | What it does |
|---|---|
| `list [--skill s] [--difficulty d] [--category c] [--context 8192\|16384\|32768] [--resource cpu-only\|needs-gpu\|vram<=N] [--split dev\|sealed-holdout] [--json]` | Lists cases with labels and split. Sealed-holdout cases show as descriptors only. |
| `inspect --case id` | Prints the brief an agent is allowed to see: instruction, snapshot paths, budgets. Never the verifier, reference, rubric or candidates. |
| `run --model tag --harness claude-code\|fixture --context N (--preset smoke \| --all [--split dev\|sealed-holdout] \| --case id) --out <dir> [--trials n] [--track single-context\|tool-retrieval] [--evidence-size N] [--position p] [--vram-mb N] [--origin url] [--fixture-dir d] [--sealed-root d] [--dry-run]` | Plans, then executes: one agent start per trial in a fresh agent tree, then the hidden verifier on a copy of the result, then `run.json` under `<out>/<runId>/`. Recorded runs are skipped on a rerun. `--preset smoke` is at most four dev cases (find, debugging, review, long-context; exposing cases first), one trial; do it first. `--all` is every dev case, three trials by default. `--dry-run` prints the plan and starts nothing. A case the adapter cannot serve is recorded `unsupported: <capability>` (`--no-tool-calling`, `--no-system-prompt`, `--no-structured-output` declare the adapter), never altered. `--harness fixture` starts no model and copies operator-authored files from `<fixture-dir>/<caseId>/`: a check of the grading path, never a result. |
| `report --dir <runs>` | Readout per configuration, split, track and category: pass/resolved with a Wilson interval, harness and infra errors and unscored beside it, grader flags. Fixture runs are labelled "NOT a model". |
| `regrade --dir <artifacts or runs>` | Re-scores stored artifacts with the grader id each was recorded with (for a runs directory, also re-runs the hidden verifier on each stored tree); an unknown grader id is an error, not a substitution. Prints `CHANGED` when the outcome differs from the recorded one. |
| `redact --dir <runs>` | Rewrites stored artifacts with secret-shaped strings removed and user paths reduced to `~`. |
| `ingest --dir <runs> --workspace <id>` | Validates and POSTs `run.json` records to `/api/model-observations/replay` (`BUILDD_API_KEY` in the environment). A record containing a secret-shaped string, or a fixture run, is refused, not sent. A v2 run scored `score-v1` (or the reverse) is rejected (HTTP 422 when every record is refused) and writes nothing. |
| `prune --dir <runs> [--days 30] [--apply]` | Deletes raw transcripts, diffs, grading output and per-run config older than 30 days; `run.json` is kept. Dry run unless `--apply`. |
| `validate`, `admit`, `export` | As in the v2 README; CPU only, no model. |

### Order of work once the window is open

1. `gpu-check`, then `run --preset smoke --model <tag> --harness claude-code --context 16384 --out <dir> --dry-run`, then the same without `--dry-run`.
2. Read the smoke runs: harness or infrastructure errors are counted apart from model failures; fix those before spending a full run.
3. `run --all` for the same policy, `report`, then `redact` and `ingest`.

Checking the harness without a GPU: `bun test scripts/local-eval/v2-claude-mock.test.ts` runs the real Claude Code CLI
through the executor against a mock Anthropic endpoint on loopback (skipped when `claude` is not installed), and
`run --harness fixture --fixture-dir <dir> --all --context 16384 --out <dir>` runs every case through grading with
files you wrote.
4. Read `/app/settings/models/comparison` (section "Coding evaluation runs"), `GET /api/model-comparison` (`replay.v2`) or the `get_model_comparison` MCP tool. Same data, three doors.

### Reading the profile

Per configuration, per split (dev and sealed-holdout are never pooled), per category: pass rate with a Wilson interval
and the runs behind it, cases and trials, cases whose trials disagreed, errors by origin (model, harness, infra),
median latency and tokens, peak VRAM (a machine-level upper bound), retries, grader flags, and the drilldown a grader
recorded: review precision and recall, citation correctness, regression success, invariants, constraint retention per
compaction stage. Unmeasured is shown as "Not recorded", never zero. A paired comparison of two configurations on the
cases both ran says `insufficient_n` below 20 resolved runs a side. There is no composite score, rank or winner.

**Conclusions to confirm independently.** A run flagged `fabrication`, `wrong_abstention`, `followed_superseded` or
`constraint_dropped`, or a passing abstention on an absence case, is listed as a candidate. It is not a verdict:
confirm it with a second search or a person before it supports any claim.

### Redaction and retention

Run records carry ids, labels, counts and rates, never a transcript; the optional `v2` block is bounded and rejects
unknown fields. Raw agent output stays on the evaluating machine and is pruned after 30 days. Sealed-holdout content
is never in the repository, only its hash.
