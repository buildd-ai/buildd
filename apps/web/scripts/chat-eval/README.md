# chat-eval: how token-efficient are chat v3 and the MCP?

An experiment harness, not a CI gate (yet). It finds the questions people are
most likely to ask, runs each one through a real tool surface, and measures
what answering cost: tokens, tool calls, tool output, and whether the answer was
any good.

- **Surfaces.** `chat` is chat v3's own tool set (`buildChatTools`), with its
  per-turn group gating, instructions and context block. `mcp` is what
  `/api/mcp` advertises to an admin-level agent: the `buildd_<group>` tools by
  default, or with `--mcp-tools legacy` the one `buildd` tool (plus the other
  legacy tools) and its server instructions. Both use the real definitions, so
  a change to a description or schema shows up in the next run. The MCP tool
  list is recorded in `meta.json` and the run id (`…-mcp-groups-…`,
  `…-mcp-legacy-…`).
- **Reads are live, writes never run.** A local stdio MCP proxy
  (`lib/proxy.ts`) serves the surface's tools to `claude -p`. On `chat` it runs
  chat's real tool `execute` over HTTP with a buildd key: same task-word
  resolution, same fan-out of unscoped list reads across workspaces, same result
  object. On `mcp` it forwards to the remote server. A write gets the answer an
  approval card would ("nothing ran; the user decides") and is logged as a
  proposal. Read vs write on `mcp`: the chat registry's op class for an action
  chat exposes, else `MCP_ONLY_CLASS` in `lib/surfaces.ts` (so `list_runners`,
  deferred in chat, still runs on `mcp`). `safety.test.ts` checks every MCP
  action is classified by exactly one of the two; unknown actions and tools
  count as writes.
- **OAuth only.** Every `claude` child gets an env with no Anthropic API
  credentials, and a run whose init reports any `apiKeySource` other than
  `none` aborts. Cost figures from these runs are virtual.
- **Jev is the one exception.** `questions --classify` runs chat's own router
  (`routeTurn`: complexity, intent, area), and `judge` scores answers. Each is
  one small OpenRouter decision call per question.
- **Routing deadline.** Classification uses an 8s deadline so it measures the
  questions, not the network. Production routes at `ROUTING_TIMEOUT_MS`
  (900ms) and a slow call is a fallback turn. `--timeout 900` observes that:
  on `questions --classify` it tallies outcomes (`decision`, `low_confidence`,
  `error:<kind>`) and latency from each call's routing record, writes the
  records to `routing-<ms>ms-<ts>.jsonl` and leaves stored classifications
  alone; on `run` it routes every question live at that deadline and keeps the
  record in `results.jsonl`. The eval passes its own key, so unlike production
  none of the deadline goes on the policy check or key lookup.

## Run it

From `apps/web`. Anything that calls Jev needs the team's decision key, which
means the prod `ENCRYPTION_KEY` (the one in `.env.local` can be stale). Wrap
those commands in `doppler run -p buildd -c prd -- …`, or set `OPENROUTER_API_KEY`.

```bash
bun run chat-eval static                         # offline sizes, no model calls
bun run chat-eval probe                          # exact token overhead per tool set (OAuth, haiku)
bun run chat-eval probe --per-tool               # ...and per tool (57 tiny calls)

bun run chat-eval questions --mine --days 60     # real chat messages (DATABASE_URL)
bun run chat-eval questions --synth 40 --replace # likely questions, grounded in live state (OAuth)
bun run chat-eval questions --add "what's stuck?" --weight 5
doppler run -p buildd -c prd -- bun run chat-eval questions --classify
doppler run -p buildd -c prd -- bun run chat-eval questions --classify --timeout 900   # production's deadline
bun run chat-eval questions --list

bun run chat-eval run --surface chat             # routing jev (default) | fallback | all
bun run chat-eval run --surface mcp              # group tools (default: --mcp-tools groups)
bun run chat-eval run --surface mcp --mcp-tools legacy   # the one `buildd` tool
bun run chat-eval run --surface chat --area tasks --limit 5 --model haiku --label try-x
doppler run -p buildd -c prd -- bun run chat-eval judge --run <id>
bun run chat-eval report --run <id> --vs <other-id>
```

Everything is written to `.eval-data/chat-eval/` at the repo root, which is
gitignored: questions and transcripts are real workspace text, and this repo is
public. Each run keeps `results.jsonl` (per question: steps, usage, tool
uses, answer, judgement), `calls.jsonl` (every tool call with its output size)
and `report.md`.

## Iterating on a change

1. Baseline: `run` + `judge` on the current code.
2. Change a description, schema, group or result format in `src/lib/chat/`.
3. `static` / `probe` for the fixed cost, then `run --label <change>` on the
   same questions, `judge`, and `report --run <new> --vs <baseline>`.

Question weights make the averages reflect how often something is asked: real
messages count once per time they were seen, synthesized ones carry the
generator's 1 to 5 likelihood.

## Known gaps against real chat

- Models: runs use Claude over OAuth (`--model sonnet|haiku|opus`, or `tier`
  to map the routed tier to haiku/sonnet/opus). A team's chat tiers may point
  at other providers.
- Tool names reach the model prefixed `mcp__eval__`, which adds a few tokens per tool.
- Every workspace counts as recently active, so an unscoped list read may fan
  out to more workspaces than chat's 14-day activity filter would allow.
- On `--mcp-tools legacy`, `check_path_claim`, `send_worker_message` and
  `buildd_memory` are not classified and are blocked as writes.
- `list_watches` reads nothing: watches belong to a signed-in person. `recall`
  goes to the remote server's recall.
- One turn per question. Follow-ups and approval continuations aren't modelled.
