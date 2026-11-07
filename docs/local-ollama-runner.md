# Running buildd tasks on a local Ollama model

A buildd runner can send a task's model traffic to an Ollama server on its own
machine, for Claude-backend and Codex-backend tasks alike. The setting is
per-machine runner configuration. It is never sent to or read from the buildd
service, and the runner refuses any address that is not loopback.

## What was and was not verified

| Path | Status |
| --- | --- |
| Env parsing, loopback refusal, Claude subprocess env, generated Codex `config.toml` provider block | Unit-tested (`apps/runner/__tests__/unit/local-model-endpoint.test.ts`) |
| Smoke script pure parts (config, model match, context, request/response shapes) | Unit-tested (`scripts/smoke-local-ollama.test.ts`) |
| Claude Code and Codex actually completing a task against a real Ollama; tool-call quality on any given model; the end-to-end recipe in section 5 | **Not run.** The worker sandbox that wrote this has no Ollama and no GPU. Treat sections 3 to 5 as the procedure to validate on your hardware, and report what differs. |

## 1. Prerequisites

1. Install Ollama on the runner machine (https://ollama.com).
2. Keep it on loopback. The default bind is `127.0.0.1:11434`; do not set
   `OLLAMA_HOST` to `0.0.0.0`. The runner rejects non-loopback URLs anyway.
3. Pull a coding-capable model that supports tool calling (check its Ollama
   page for the `tools` tag). Pick the largest your memory allows.
   ```bash
   ollama pull <model>
   ```
4. Raise the context length. Ollama's default window is small, and an agent
   session carries a system prompt, tool schemas and file reads. Start the
   server with at least 32k, preferably more:
   ```bash
   OLLAMA_CONTEXT_LENGTH=65536 ollama serve
   ```
   Or bake it into a model with a Modelfile line `PARAMETER num_ctx 65536`.
   A larger window needs more memory; the model may then spill to CPU and slow
   down sharply.
5. Check it all with the smoke script (needs no login):
   ```bash
   BUILDD_LOCAL_MODEL=<model> bun run scripts/smoke-local-ollama.ts
   ```
   It checks Ollama is reachable, the model is pulled, context is adequate
   (`--min-context N`, default 32768), then sends one request on the
   Anthropic-compatible and one on the Responses wire. It exits nonzero with a
   message saying what to change.

## 2. Runner configuration

Set these in the environment of the runner process, then restart it:

| Variable | Meaning |
| --- | --- |
| `BUILDD_LOCAL_MODEL_URL` | `http://localhost:11434`. Loopback only (`localhost`, `127.x`, `::1`). |
| `BUILDD_LOCAL_MODEL` | The model name, required with the URL. |
| `BUILDD_LOCAL_MODEL_CONTEXT` | Optional window in tokens, written into the Codex config. Keep it at or below what the server runs with. |

When set, and when the claim allows this machine's own model credentials
(not a personal-keys-only requester), the local model wins over a team model
endpoint and any per-machine provider for **every** task this runner takes.

**Claude route (Anthropic-compatible).** The agent gets
`ANTHROPIC_BASE_URL=<origin>` (Ollama serves `/v1/messages`), a placeholder
`ANTHROPIC_AUTH_TOKEN`, and the haiku/sonnet/opus defaults all set to your
model. Real `ANTHROPIC_API_KEY`, OAuth token and custom headers are removed, so
no real credential reaches the local server. The session's model is your model
with no fallback.

**Codex route (Responses API).** The task's own `CODEX_HOME/config.toml`
gets, before any table header:

```toml
model_provider = "buildd_local"
model = "<model>"
model_context_window = <BUILDD_LOCAL_MODEL_CONTEXT, if set>

[model_providers.buildd_local]
name = "Local model"
base_url = "http://localhost:11434/v1"
wire_api = "responses"
requires_openai_auth = false
```

`OPENAI_API_KEY` is a placeholder. This machine's Codex login and any
server-delivered Codex key are not used. Your real `~/.codex` is never read or
written.

## 3. Filing tasks from a local session

From a local Claude Code or Codex session with the buildd MCP connected, create
the task and pin it to the local runner so only that machine claims it:

- `create_task` with `runner` set to the runner's hostname, account name or
  key (any of the three matches; `list_runners` shows them).
- Pick the workspace whose repo is checked out or cloneable on that machine.
- The runner claims it as usual, creates the worktree, and runs it on the local
  model. The cloud service never calls the runner; the runner polls.

An unpinned task can still be claimed by this runner, but may also go to any
other runner, so pin when you want the local model.

## 4. Reviewer on a different provider

A model reviewing its own work, or a small local one reviewing a small local
one, is weak. Prefer an independent reviewer: run the reviewer role on a
different runner (one with no local model set) using a hosted model. In the
workspace settings set the reviewer role (`reviewerRole`) to a role whose model
is a hosted one, and keep that role's tasks off the local runner by not pinning
them there. Because the local variables apply to the whole runner process, a
machine that has them set cannot also serve hosted-model tasks: use a second
runner for the reviewer.

## 5. End-to-end smoke recipe

1. Smoke script passes (section 1).
2. Start the runner with the variables above. Its log should show the run's
   model traffic going to the loopback origin.
3. From a local session, create a trivial pinned task, for example "add a line
   to the README" in a scratch repo.
4. Expect: a tracked worker appears on the dashboard against the local runner;
   a worktree is created; the agent edits and commits; `create_pr` opens a PR;
   CI runs; the reviewer task is created and claimed by the hosted runner.
5. Run once with a Claude-backend task and once with a Codex-backend task, since
   they use different wires.
6. If the agent never calls tools, loops, or the run ends with an empty result,
   see limitations below before assuming a runner fault.

## 6. Expected limitations

- Small models call tools badly: malformed arguments, skipped steps, edits that
  do not apply. Quality scales with model size.
- Context is bounded by what you set; long sessions hit it and degrade or fail.
- Much slower than hosted models, and sharply so when the model spills out of
  GPU memory.
- Reviewer quality is only as good as its model; see section 4.
- No cloud runners: the endpoint is loopback, so only a runner on that machine
  can use it.
- One model per runner process, for all tasks.
- Prompt features that depend on Anthropic-only behaviour (deferred tool loading,
  fallback models) are off on this route.

## 7. Restoring normal routing

Unset `BUILDD_LOCAL_MODEL_URL`, `BUILDD_LOCAL_MODEL` and
`BUILDD_LOCAL_MODEL_CONTEXT` in the runner's environment and restart it.
Nothing is stored server-side, so there is nothing else to revert. Tasks you
pinned to this runner keep working on its normal provider route.
