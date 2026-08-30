# Where secrets live

**Source of truth: Doppler project `buildd`.** Not this repo, and not any
`.env` file. `.env*` is gitignored, so nothing here tells you where values
come from — that is what this file is for.

| Doppler config | Consumed by |
|---|---|
| `prd` | Vercel project `buildd`, Production |
| `stg` | Vercel project `buildd`, Preview |
| `dev` | local development, and Vercel Development (`vercel dev`) |

## Local development

```bash
doppler setup                 # reads doppler.yaml, no prompts
doppler run -- pnpm dev       # injects secrets, no .env needed
doppler secrets --only-names  # what exists, without revealing values
```

A local `.env` still works and takes precedence, but it is a second copy of a
secret and the reason this repo needed a disaster-recovery pass in the first
place. Prefer `doppler run`.

**Never `vercel env pull` into a `.env` and read it with a dotenv parser.**
Values here can contain a literal backslash-n, which every dotenv parser
silently converts to a real newline. For `ENCRYPTION_KEY` that produces a key
that decrypts nothing while looking correct. See the runbook.

## Production

Vercel holds its own copy of the env — that is what the running app reads. Doppler
is pushed to Vercel, one way:

```bash
make -C ~/infrastructure secret-drift    # what differs, by name only
make -C ~/infrastructure secret-push     # dry run
make -C ~/infrastructure secret-push-apply
```

Doppler's own Vercel integration does this event-driven, but the Developer plan
caps it at 5 config syncs workplace-wide, so the script is the general mechanism.

**A Vercel env change does not reach a running deployment.** Redeploy after
pushing.

## CI/CD

CI does not need a `.env`. Give the runner a Doppler **service token** scoped to
one config and let it fetch:

```yaml
# GitHub Actions
env:
  DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN_DEV }}
steps:
  - run: curl -Ls https://cli.doppler.com/install.sh | sh
  - run: doppler run -- pnpm test
```

Service tokens are read-only and config-scoped, so a leaked CI token cannot reach
production secrets or write anything. Never put a `VERCEL_TOKEN` in CI or in a
local `.env`: an agent holding one wiped this project's production env on
2026-07-19.

## Runbook

`~/knowledge-base/runbooks/vercel-prod-env-restore.md` — full inventory by name,
restore procedure, and the escaping landmines. No values.
