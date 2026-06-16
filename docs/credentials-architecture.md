# Agent Credentials Architecture (SPEC)

> **Status: authoritative.** This is the pattern of record for storing any credential
> that a runner uses to authenticate an agent backend (Anthropic/Claude, OpenAI/Codex,
> and any future backend). Agents working in this repo **MUST** follow it. Do not
> introduce a new per-integration credential table — extend the unified model below.

## The rule

**All agent-backend credentials live in the single `secrets` table** with
team/account/workspace scoping. There is exactly one storage table and one scoping
model for credentials. New backends add a new `purpose`, not a new table.

❌ **Anti-pattern (do not do this):** a dedicated table like `codex_credentials`,
`anthropic_credentials`, `xyz_credentials` with its own `workspaceId` column and its
own CRUD. This was the original Codex implementation; it is being retired precisely
because it could not share one secret across workspaces and forced a parallel scoping
implementation. If you find yourself writing `pgTable('..._credentials', ...)`, stop.

## Why

- **One secret can cover all workspaces.** The `secrets` table already supports
  team-wide, account-wide, and workspace-scoped rows via nullable `accountId` /
  `workspaceId`. A team-wide row (`accountId = NULL, workspaceId = NULL`) is shared by
  every workspace in the team — the user connects once, not once per workspace.
- **One lookup/precedence implementation.** The claim route resolves credentials with a
  single fallback query. Parallel tables mean parallel (and divergent) lookup logic.
- **One UI.** Claude and Codex credentials are entered in one settings section with one
  scope selector, because they share one storage + scoping model.

## The `secrets` table

`packages/core/db/schema.ts` → `secrets`. Relevant columns:

| Column | Meaning |
|---|---|
| `teamId` | Required. The owning team. |
| `accountId` | Nullable. `NULL` = applies to all accounts in the team. |
| `workspaceId` | Nullable. `NULL` = applies to all workspaces in the team. |
| `purpose` | Discriminator: `anthropic_api_key`, `oauth_token`, `codex_credential`, `mcp_credential`, `webhook_token`, `vercel_token`, `custom`. |
| `label` | Optional. For `mcp_credential` it is the env-var name. |
| `encryptedValue` | AES-256-GCM ciphertext. For multi-field credentials, encrypt a JSON blob (see Codex below). |
| `tokenExpiresAt` | Nullable. Set for token credentials that expire (`codex_credential`, `oauth_token`). Enables efficient "expiring soon" cron queries. |
| `lastRefreshedAt` | Nullable. Set for token credentials that auto-refresh. Doubles as the optimistic-lock column for refresh (see below). |

### Scoping precedence (most specific wins)

When resolving a credential for a task in workspace `W` (team `T`) claimed by account `A`:

```
SELECT ... FROM secrets
WHERE teamId = T
  AND purpose = :purpose
  AND (accountId IS NULL OR accountId = A)
  AND (workspaceId IS NULL OR workspaceId = W)
```

Then pick the **most specific** match:

1. `workspaceId = W` (workspace-specific)
2. `accountId = A`, `workspaceId IS NULL` (account-wide)
3. `accountId IS NULL`, `workspaceId IS NULL` (team-wide)

For single-valued credentials (one Codex login per scope) the resolver returns the single
most-specific row. The claim route already applies the team/account/workspace filter for
`anthropic_api_key` / `oauth_token` / `mcp_credential`; `codex_credential` uses the same
filter plus the precedence pick.

## Multi-field credentials (Codex)

`secrets.encryptedValue` holds a single string, so a credential with several fields is
stored as an **encrypted JSON blob**:

```jsonc
// plaintext, before encrypt() — purpose = 'codex_credential'
{ "access_token": "...", "refresh_token": "...", "account_id": "..." }
```

- `tokenExpiresAt` and `lastRefreshedAt` are stored as **real columns** (not inside the
  blob) so the refresh cron can query expiry in SQL and the refresh lock can be atomic.
- `account_id` is not secret but lives in the blob for atomicity; surface it to the UI by
  decrypting (status endpoint).

**Input normalization.** `normalizeCodexAuthJson()` accepts what the user actually pastes:
the raw `~/.codex/auth.json` (credential fields nested under a `tokens` object) **or** an
already-flat object. Expiry is resolved from explicit `expires_in` / `expiry`, else decoded
from the access-token JWT `exp` claim; if none is derivable the credential is still stored
with no expiry. Keep this normalization **server-side** — never push format-wrangling (jq,
JWT base64url decoding, clipboard tools) into the UI, where it rots across CLI versions and
operating systems.

### Token refresh + rotation lock

OpenAI rotates the refresh token on every use, so a refresh must always persist the new
refresh token. Concurrency is controlled with a DB-level optimistic lock on
`lastRefreshedAt`:

```
UPDATE secrets
   SET lastRefreshedAt = NOW()
 WHERE id = :id
   AND (lastRefreshedAt IS NULL OR lastRefreshedAt < NOW() - INTERVAL '60 minutes')
RETURNING *
```

Only the caller whose `UPDATE ... RETURNING` returns a row holds the lock and performs the
network refresh; concurrent callers get `locked`. This is the same pattern the retired
`codex_credentials` table used — preserved, just keyed off `secrets`.

> Per CLAUDE.md, do **not** use `db.transaction()` with the neon-http driver. The atomic
> `UPDATE ... WHERE ... RETURNING` above is the locking mechanism.

## Adding a new backend (checklist)

1. Add a `purpose` value to `SecretPurpose` in `packages/core/secrets/types.ts` **and** the
   `secrets.purpose` `$type<...>` union in `packages/core/db/schema.ts`. (Both are text —
   no DB enum migration needed for the purpose itself.)
2. If the credential has multiple fields, store an encrypted JSON blob in `encryptedValue`.
3. If it expires/refreshes, set `tokenExpiresAt` / `lastRefreshedAt` and reuse the refresh
   lock pattern above.
4. Resolve it in the claim route using the scoping precedence query — do not add a new
   lookup path.
5. Surface it in the unified Agent Backends settings section with the shared scope selector
   (default: all workspaces / team-wide).
6. **Do not create a new table.**

## Files

- Schema: `packages/core/db/schema.ts` (`secrets`)
- Provider: `packages/core/secrets/` (`postgres-provider.ts`, `types.ts`)
- Codex helper (blob + refresh): `apps/web/src/lib/codex-credential.ts`
- Claim-time resolution: `apps/web/src/app/api/workers/claim/route.ts`
- Refresh cron: `apps/web/src/app/api/cron/codex-token-refresh/route.ts`
- Settings UI: `apps/web/src/app/app/(protected)/settings/` (Agent Backends section)
