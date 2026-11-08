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
