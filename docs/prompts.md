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
own measurement. `scripts/private-prompt-eval.ts` loads a prompts directory
with the seed's checks, installs it as the text in effect, and runs every
decision benchmark set (`scripts/decision-benchmark-sets.ts`) that has
labelled cases over it:

```sh
bun run scripts/private-prompt-eval.ts --dry-run                                   # public defaults, no model calls
OPENROUTER_API_KEY=... bun run scripts/private-prompt-eval.ts --prompts ../my-prompts
```

Cases live next to your prompts, not in this repo: `<dir>/evals/<set>.jsonl`
(`task-category.jsonl`, `heartbeat-triage.jsonl`, `task-role.jsonl`), in the
format `scripts/decision-benchmark.ts` documents. The report lists each prompt
id with the row version and content hash that was scored, beside its scores.
It never contains prompt text or case content: every byte is checked against
the loaded bodies before it is written, and a match fails the run instead.
`--require` makes a run with no private text, no cases or no key exit non-zero.

buildd's own deployment runs this nightly (`.github/workflows/private-prompt-eval.yml`).
It reads the prompts repo (`vars.PROMPTS_REPO_NAME`, default `<repo>-prompts` under the same owner) with `PROMPTS_REPO_TOKEN` or the release GitHub App,
calls the model with `OPENROUTER_API_KEY`, and fails, naming the secret, when
either is missing.
