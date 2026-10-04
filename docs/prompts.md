# Prompts: public defaults and deployment overrides

Every prompt the server sends a model (decision questions, the chat system
prompt) has a working public default compiled into this repo. A deployment can
replace any of them with its own text, stored as versioned rows in the
`prompts` table. **Nothing is required**: with no rows, every prompt runs its
public default, and a self-hosted deployment works exactly as the code reads.

## How a prompt resolves

- `resolvePrompt` / `definePromptedDecision` (`packages/core/prompts.ts`,
  `packages/core/prompted-decision.ts`) return the active row's body, or the
  public default when there is none.
- Rows are read into an in-process snapshot at boot and refreshed in the
  background. No call reads the database, and a missing table, row or database
  never fails a call.
- An override must keep the default's shape. For a decision that means the same
  question names and types, the same choice labels and the same score level
  count. A template must use the same `{{placeholders}}`, and a structured
  (JSON) prompt must keep the same keys and leaf types. An override that does
  not fit is rejected at resolve time and the default runs.
- Every prompt id the code reads is registered next to its default
  (`registerTextPrompt`, `registerTemplatePrompt`, `registerValuePrompt`,
  `registerPromptedQuestions`, or implicitly by `definePromptedDecision`). The
  list is `apps/web/src/lib/prompt-catalog.ts`.

## Bringing your own prompts

1. Export the public defaults as a starting point. Ids match the code exactly:

   ```sh
   bun run apps/web/scripts/export-prompt-defaults.ts --out ../my-prompts
   ```

   This writes `prompts/<id>.json` (decision questions, structured prompts) or
   `prompts/<id>.md` (text and templates) and a `manifest.json`: `{ "prompts": [{ "id", "version", "file", "sha256" }] }`.
   `sha256` is the hash of the file's exact bytes; `version` is the row version
   and is immutable, so a changed file needs a new version.

2. Edit the files, bump each changed entry's `version` and `sha256`, and keep
   the directory in a repo you control.

3. Seed. The web build runs `bun run prompts:seed` right after `db:migrate`.
   It reads the directory from GitHub when `PROMPTS_REPO` is set:

   | Env var | Meaning |
   |---|---|
   | `PROMPTS_REPO` | `owner/name` of the repo holding the directory. Unset: the seed is skipped. |
   | `PROMPTS_REPO_REF` | Branch, tag or sha to read (default `main`). |
   | `PROMPTS_REPO_TOKEN` | Optional token with contents read on that repo. Unset: the deployment's GitHub App (`GITHUB_APP_ID` + private key) mints a read-only token for that one repo, if it is installed there. |

   Or seed from a checkout: `bun run apps/web/scripts/seed-prompts.ts --dir ../my-prompts --strict`.

The seed is all-or-nothing on validation: an id the code does not register, a
file that does not match its `sha256`, an override the reader would reject or a
version reused with different text refuses the whole seed, and nothing is
written. Otherwise it inserts each new version and activates it; an unchanged
version is a no-op, and an id dropped from the manifest is deactivated (it
falls back to its default). Without `PROMPTS_REPO`, a token or a database, or
when the repo cannot be read, the seed logs one line and the build continues.
Add `--strict` to make a refusal or read failure exit non-zero. Logs name ids,
versions and counts, never text.

## Checking what runs

- `GET /api/deploy-identity` returns `prompts.active`: id, version and content
  hash of each active row in that instance (never text). An id not listed runs
  its public default. `prompts.fallbacks` counts that instance's resolves that
  used a default.
- In production, once a seed has run, a server process logs each id that falls
  back, and the release health check cron (`/api/cron/release-health-check`)
  pages the operator once per distinct set of seeded ids that would resolve to
  their public default (`apps/web/src/lib/prompt-fallback-alert.ts`). A
  deployment that never seeded is never alerted.

## Measuring your prompts

Public tests only exercise the public defaults, so replacement text needs its
own measurement: the prompt eval scores every decision benchmark set
(`apps/web/src/lib/prompt-evals/benchmark-sets.ts`) that has labelled cases
over the text in effect, and reports each prompt id with the row version and
content hash that was scored beside its scores.

Cases live next to your prompts, not in this repo: `<dir>/evals/<set>.jsonl`
(`task-category.jsonl`, `heartbeat-triage.jsonl`, `task-role.jsonl`), in the
format `scripts/decision-benchmark.ts` documents.

### On the server

With `PROMPTS_REPO` set, the deployment runs the eval itself
(`apps/web/src/lib/prompt-evals/run.ts`):

| Trigger | Scores |
|---|---|
| A push to `PROMPTS_REPO` on the `PROMPTS_REPO_REF` branch (GitHub App webhook) | the pushed sha, before the next deploy seeds it |
| `GET /api/cron/prompt-evals`, weekly (`cron-manifest.json`) | the ref the seed reads |
| `POST /api/admin/prompt-evals` with `{ ref?, model?, dryRun? }` (platform admin key) | the given ref, else the seed's |

- **Text and cases** are read from the prompts repo with the seed's own
  credential (`PROMPTS_REPO_TOKEN`, else the GitHub App) and checked by the
  seed's loader, so an eval refuses exactly what a seed would. The text is
  applied for the eval's own call tree only (`@buildd/core/prompt-overlay`):
  live calls in the same instance keep resolving the deployment's rows.
- **Key**: the paying team's decision route, resolved as a live decision call
  resolves it (an OpenRouter key from the team's secrets, or its LiteLLM
  gateway when the team's decision model uses one). No new secret. The admin
  route spends the caller's team; the cron and the push spend the team of the
  first account in `BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`.
- **Model**: `PROMPT_EVAL_MODEL`, default `deepseek/deepseek-v4.1-flash` (a
  cheap chat model with token logprobs), overridable per run. Each run also
  records the model the team's live decisions use; when they differ the run is
  flagged (`modelMismatch`), because scores from another model do not predict
  production behaviour.
- **Bounded**: one invocation, 8 calls at a time, a 240s whole-run budget.
  Cases the budget leaves unstarted are counted as not run and fail the run.
- **Results**: `prompt_eval_runs` (trigger, ref, eval and live model, status,
  cost, problems) and `prompt_eval_results` (per set: prompt id, row version,
  content hash, prompt version, model, cases, accuracy, keyword baseline,
  coverage/accuracy at 0.9 confidence, errors, not run, cost). Read them with
  `GET /api/admin/prompt-evals?limit=N`. They never hold prompt text, case
  content or error strings: before anything is written, the whole report is
  checked against every loaded body and every public default, and a match
  writes no results and marks the run `refused`.

### From a checkout

`scripts/private-prompt-eval.ts` runs the same core over a local directory (a
self-hosted deployment, or trying text before you push it):

```sh
bun run scripts/private-prompt-eval.ts --dry-run                                   # public defaults, no model calls
OPENROUTER_API_KEY=... bun run scripts/private-prompt-eval.ts --prompts ../my-prompts
```

It applies the same leak check to its markdown and JSON before printing them.
`--require` makes a run with no private text, no cases or no key exit non-zero.
