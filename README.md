# buildd

**Agents say they're done. buildd checks.**

You write down what done means, as checks. Agents do the work on runners you control. buildd runs the tests, its own review agents and its decision models, and nothing counts as done until the checks pass.

[buildd.dev](https://buildd.dev) · [Docs](https://docs.buildd.dev) · [Dashboard](https://buildd.dev/app)

## How it works

1. **Start with what done means.** You give a mission its goal criteria. Where it can, buildd runs each one as a check: a command that must exit 0, PRs that must merge, an artifact that must exist. A criterion no command can express stays a plain sentence, and a model grades it. A mission can't complete until every criterion passes.
2. **You only get asked when it matters.** When an agent asks a question, a decision model answers the low-stakes ones on the spot. Questions that touch migrations, auth and secrets, CI or deploys, protected paths or spending always come to you.
3. **buildd checks the work.** buildd won't merge a PR on red CI. Depending on the merge policy you pick, a reviewer agent reads the change and approves it, sends it back to the author or escalates to you, and a visual auditor screenshots the pages a mission changed. Work that falls short goes back.

The server coordinates and never runs an agent. Runners claim tasks over the REST API, do the work in a git worktree, open the PR and report back. Agent runs take minutes to hours, longer than a serverless request can live.

## Quick start

```bash
curl -fsSL https://buildd.dev/install.sh | bash
exec $SHELL
buildd
```

Then open http://localhost:8766 and connect your account.

The installer clones the runner into `~/.buildd`, installs Bun if you don't have it, puts the `buildd` launcher in `~/.local/bin` and adds that to your shell rc. It offers to register a background service at the end; pass `--service` to register it without asking (`curl -fsSL https://buildd.dev/install.sh | bash -s -- --service`). Windows: `irm buildd.dev/install.ps1 | iex`.

On a headless or SSH machine with no browser, connect from the terminal instead:

```bash
buildd login --device
```

`buildd login` also registers the buildd MCP server in `~/.claude.json`, so Claude Code can create and work tasks. Runner commands, the background service and env overrides are in [apps/runner/README.md](apps/runner/README.md).

Next: create a workspace and your first mission in the [dashboard](https://buildd.dev/app), and read the [runner guide](https://docs.buildd.dev/docs/getting-started/runner).

## Where it runs

| Where | Status | |
|---|---|---|
| Your machine or server | Available | Laptop, build box, VM. Runners connect out to buildd; nothing has to reach in. |
| Your Cloudflare account | Preview | A fresh container per task, with a short-lived GitHub token for one repo ([apps/cloud-runner](apps/cloud-runner)). |
| Hosted by us | Coming soon | We run the runner; you still bring your own model key. |

Specs, review and merge rules are the same wherever the runner lives.

## Models

Bring your own key. Store it in buildd, team-wide or for one workspace, and runners receive it when they claim a task.

- **Anthropic** API key for Claude tasks
- **OpenRouter** key
- **LiteLLM** or another OpenAI-compatible gateway (`apiKey` + `baseUrl`)
- **OpenAI** API key for Codex tasks

Each task runs on Claude (Agent SDK) or Codex, picked per task, role or workspace. Credentials live in one encrypted `secrets` table; see [docs/credentials-architecture.md](docs/credentials-architecture.md).

Every prompt the server sends a model has a public default in this repo, and a deployment can override any of them ([docs/prompts.md](docs/prompts.md)).

## Repo layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js dashboard, REST API and MCP server (`src/app/api/mcp`) |
| `apps/runner` | The runner: claims tasks, runs agents, local web UI and `buildd` CLI (Bun) |
| `apps/cloud-runner` | Cloudflare Worker that runs one container per task |
| `apps/dispatch` | Cloudflare Worker for queued delivery, timers and retries |
| `apps/model-policy` | Cloudflare Worker that maps a surface and tier to a provider and model |
| `packages/core` | Drizzle schema and migrations, knowledge store, model routing, question gate |
| `packages/shared` | Types shared by the server and the runner |
| `packages/ai-kit` | Chat components, tool permissions and model plans for your own app (`@builddai/ai-kit`) |
| `packages/dispatch-contract` | Wire types between buildd and the dispatch Worker |

The product spec lives in [docs/SPEC.md](docs/SPEC.md), with per-capability contracts in [docs/specs/](docs/specs/).

## Contributing

```bash
bun install
cp apps/web/.env.example apps/web/.env.local   # fill in DATABASE_URL, AUTH_SECRET, ...
bun dev
```

Run the unit tests with `bun run test`, not `bun test`. The script runs each test file in its own process; `bun test` loads them all into one, and module mocks leak between files. Read [CLAUDE.md](CLAUDE.md) for repo conventions (branching, migrations, the public-repo rules) and [docs/testing.md](docs/testing.md) for the test layout. PRs target `dev`.

## License

Licensing is per directory. Check the `license` field in each `package.json`.

| Path | License |
|---|---|
| `apps/runner`, `packages/shared`, `packages/ai-kit`, `packages/dispatch-contract` | [Apache-2.0](apps/runner/LICENSE) |
| `packages/openclaw-skill` | MIT |
| Everything else, including the server (`apps/web`) and `packages/core` | [FSL-1.1-ALv2](LICENSE) |

The Functional Source License lets you read, modify, self-host and use the server for anything except a competing product or service. Each release becomes Apache-2.0 two years after it ships.
