# Doc Drift Punch-List

> Reconciliation backlog to realign downstream artifacts against `docs/SPEC.md`
> (the canonical spec). Source of truth = code. Generated 2026-06-21 from a
> four-source drift audit (code vs. `knowledge-base` vs. `buildd-docs` vs. `buildd-site`).
>
> Priority: **P0** = actively wrong / misleads users · **P1** = missing major shipped
> feature · **P2** = stale-but-harmless / polish.

## Drift summary

| Source | Last real update | Drift | One-line verdict |
|--------|------------------|-------|------------------|
| code (`buildd`) | today | — | source of truth |
| `buildd-site` | ~Mar 22 (3mo) | newest framing, frozen | right narrative, stale tooling emphasis |
| `knowledge-base` | ~Apr 8 (2.5mo) | mid | best legacy spec; predates Codex/secrets/knowledge/routing |
| `buildd-docs` | ~Mar 21 (3mo) | **broken** | documents removed features as live (~40% off) |

The dominant story: an `objectives → missions` migration (plus recipes removed,
heartbeat folded in) that reached **code** and the **site**, but left **buildd-docs**
describing a product that no longer exists.

---

## buildd-docs (`~/buildd-docs`) — highest priority

### P0 — actively wrong
- [ ] **Delete `features/objectives.mdx`** (~247 lines). No `objectives` table, no
  `manage_objectives` MCP action, no endpoints. Replace any inbound links with Missions.
- [ ] **Delete/replace `features/heartbeat.mdx`**. Heartbeat is not a user feature;
  `worker_heartbeats` is infra liveness. The page even says "replaced by objectives"
  (which don't exist) — doubly wrong.
- [ ] **Remove `recipes` page / references**. Recipes were removed (~Apr 2026).
- [ ] **Scrub `getting-started/runner.mdx`** of "heartbeat monitoring" availability language.

### P1 — missing shipped features (no docs at all)
- [ ] **Agent backends (Claude + Codex)** — per-task `backend`, role/workspace
  `defaultBackend`, resolution precedence. (See `docs/SPEC.md` §3.)
- [ ] **Secrets & credentials** — unified `secrets` store, purposes, scoping,
  server-managed delivery to runners. (Page exists but predates the model — verify
  against `docs/credentials-architecture.md`.)
- [ ] **Workspace memory / knowledge store** — hybrid semantic+lexical retrieval,
  `buildd_memory` MCP tool, what gets embedded.
- [ ] **Smart model routing** — `kind`/`complexity`, claim-time model pick, calibration.
- [ ] **Missions overview** — expand the thin page: shared working branch + single PR,
  `requiresReview`, sub-missions, schedule linkage, derived health.
- [ ] **CI watchers** (`watched_projects`) and **auto-merge rules** (`autoMergeOnGreenCI`,
  deny-paths, max-lines).

### P2 — stale but harmless
- [ ] Refresh Feb-era pages: `schedules.mdx`, `github.mdx`, `workspace-config.mdx`,
  `teams.mdx`, `deployment/self-hosting.mdx`.

---

## buildd-site (`~/buildd-site`)

### P1
- [ ] **Re-evaluate OpenClaw emphasis** on `/integrations` — confirm it's still the
  primary external-agent pattern, or demote.
- [ ] **Fix `/integrations` theme mismatch** (dark-blue palette vs. site copper/charcoal;
  off-brand CTA). It's an un-refactored early page.

### P2
- [ ] Confirm Memory product split (dedicated page) still matches strategy.
- [ ] `/pricing` is a "free while in beta" placeholder — update when monetization lands.
- [ ] Narrative is current (Dispatch/Connect/Deliver, "dispatch missions") — keep, but
  verify capability claims against `docs/SPEC.md` §1.

---

## knowledge-base (`~/knowledge-base`)

### P1
- [ ] **Demote to research/history.** It is no longer a spec source — `docs/SPEC.md` is.
  Add a banner to `CLAUDE.md`/`README.md` pointing to `buildd/docs/SPEC.md` as canonical.
- [ ] `plans/buildd/missions-architecture.md` is the best legacy spec but predates
  Codex, unified secrets, knowledge store, and routing — mark stale, don't act on it.
- [ ] `integration-status.md` SDK version pins (>=0.2.77) are unverified — don't trust.

---

## Code hygiene (in `buildd`)

### P2
- [ ] Remove empty scaffolds `apps/agent`, `apps/mcp-server`, `apps/local-ui` (node_modules
  only) — or document why they're retained.
- [ ] Drop deprecated `accounts.oauthToken` / `accounts.anthropicApiKey` columns once
  no readers remain (migration).
- [ ] `CLAUDE.md` doesn't mention the backend enum or server-managed creds — add a one-liner
  pointing to `docs/SPEC.md`.

---

## How this list gets maintained

These items are intended to be filed as buildd tasks (workspace: buildd) and worked via
the normal lifecycle. The `spec-sync` skill regenerates this list by diffing the doc
sources against `docs/SPEC.md` + the knowledge store. Re-run it after major schema/route
changes.
