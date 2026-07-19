# Reliable Environment Provisioning

**Status:** Phases 1–4 shipped (2026-07-18) — verifier core + `buildd env verify` CLI + auto-detection, the runner provision gate, the CI bootstrappability check, and the secret contract (`env.required` validated against the injected worker env). Design complete; see open questions for follow-ups.
**Owner:** max
**Related:** `apps/runner/src/git-operations.ts` (worktree setup), `apps/web/src/lib/role-config.ts` (env mapping → R2), the `secrets` table, `docs/credentials-architecture.md`.

---

## Problem

Most wasted agent runs share one root cause: **the workspace wasn't proven runnable before the agent started work.** The failure wears many costumes, but it's one bug:

- worktree crash-loops on a missing `@buildd/core` module (sparse-checkout stripped `packages/core`)
- `bun install` in the worktree is **best-effort** — it only warns on failure (`git-operations.ts` `installWorkspaceDeps`), so an agent can start against a half-installed tree
- per-clone `core.hooksPath` / other setup that isn't captured in the repo
- a required secret (`DATABASE_URL`) malformed for weeks, silently soft-skipped
- toolchain drift (stale `.bun/` SDK copies, wrong runtime version)

In each case an agent claims the task, burns budget discovering the environment is broken, and fails in a way that reads as `race_lost` or a stall rather than "environment not provisioned." **The runner clones, best-effort installs, and hopes.** There is no phase that *proves* the workspace is healthy, and no budget-free place to fail when it isn't.

## Goals

1. A repo can **declare how to become runnable** in one place.
2. The runner executes provisioning as a **distinct, observable phase that must pass before the agent is allowed to touch the task** — and before it costs agent budget.
3. A failed provision produces a **diagnosable reason**, not an agent flailing.
4. The same contract is usable **outside the runner** — CI and a human's fresh clone.

## Non-goals

- Reinventing toolchain managers. Wrap devcontainers / Nix / asdf for the "install the right runtime" half; don't rebuild it.
- Language-specific plugins. We shell out to *declared commands*; multi-language support falls out of that, it is not the feature.
- Sandbox/isolation policy (covered by `gitConfig.sandbox` and `docs/design/private-task-execution.md`).

## The shape: contract + readiness gate

This is **primarily a config + a verification runtime**, not a "support more languages" feature. The value is the enforced gate and its reporting, not the manifest.

### 1. Manifest — `.buildd/env.yaml` (auto-detected when absent)

```yaml
toolchain:
  runtime: bun@1.3.14        # or node@20, python@3.12 — pinned
  # detection fallback: bun.lockb → bun, package-lock.json → npm, uv.lock → uv, ...
install:
  command: bun install --frozen-lockfile
  # must be deterministic; frozen/locked by default
env:
  required: [DATABASE_URL, VOYAGE_API_KEY]   # hard preconditions
  # sourced from the `secrets` table via existing scoping precedence
readiness:                     # THE differentiator — proves the env works
  command: bun run scripts/check-specs.ts --check && cd apps/web && bunx tsc --noEmit
  timeout: 180
provision:                     # idempotent setup that must run per-clone
  - git config core.hooksPath .githooks
```

`requiredEnvVars` already exists on roles and the `secrets` table already does scoped injection — this manifest **completes and enforces** primitives buildd half-has, rather than adding new ones.

### 2. Provision phase in the runner

Slots into `setupWorktree` after `git worktree add`, before the agent loop:

```
clone/worktree → toolchain check → install → env contract → provision hooks → READINESS PROBE
                                                                                     │
                                          pass → agent may claim & work ────────────┤
                                          fail → task returns to queue with a        │
                                                 structured provision-failure reason │
                                                 (no agent budget spent) ────────────┘
```

The readiness probe is the gate today's flow lacks. If it fails, the task fails **fast and cheap** with a reason a human (or the organizer) can act on, instead of an agent spending minutes discovering `@buildd/core` won't resolve.

### 3. Standalone verifier — `buildd env verify`

The same manifest + phases, packaged as a CLI that exits nonzero with a readable diagnosis. One spec, three consumers:

- **runner** — the provision phase above (fail fast, protect budget)
- **CI** — a PR that breaks bootstrappability (lockfile drift, sparse-checkout regressions) fails *before* it ever reaches an agent
- **human** — `buildd env verify` on a fresh clone instead of "why doesn't the build work"

This portability is the reason to build it as a **contract + CLI** rather than bury the logic in the runner — the current best-effort install is exactly the buried-logic mistake.

## Why buildd can win here

Buildd already has the agent-native primitives general tools lack: the `secrets` table (scoped credential injection), `requiredEnvVars`, and `role-config.ts` bundling env mappings. Devcontainers/Nix solve the toolchain half but have no notion of *"scoped secrets + a readiness gate tied to who is claiming this task."* The wedge is that second half: **secret contract + readiness gate + fail-before-budget**, layered on top of (not instead of) existing toolchain managers.

## Phased rollout

1. **Verifier core** ✅ *shipped* — `apps/runner/src/env-verify.ts`: manifest parser (`Bun.YAML`), step planner, injectable executor, and `buildd env verify` CLI (`--json` for machines). Auto-detection from lockfiles (bun/pnpm/yarn/npm/uv/poetry/cargo/go) so existing repos get value with zero config. Fails fast, exits nonzero, blames the earliest phase. Dogfooded via this repo's `.buildd/env.yaml`.
2. **Runner integration** ✅ *shipped* — `WorkerManager` runs `runProvisionGate` before the agent's budget-consuming SDK loop. On failure the worker is marked failed with a structured `Provision failed [<phase>]: …` reason and the agent never starts (**zero budget spent**). *(Phase 4 moved the call into `startSession` so it runs against the fully-assembled worker env — see below.)* Two safety properties: **enforcement is opt-in** — only a declared `.buildd/env.yaml` blocks; auto-detected plans stay advisory (CLI/CI only), so no existing workspace regresses. And the gate is **non-blocking** (async `exec`, never stalls the runner's other workers) and **skips the `install` phase** (the runner already ran its own tolerant install; readiness proves the tree usable). A gate that itself errors fails *open*. *Requeue policy note:* a blocked task is marked failed (diagnosable), not auto-requeued — retry-vs-escalate is the failure-taxonomy open question below; auto-requeue on a broken manifest would loop.
3. **CI check** ✅ *shipped* — `.github/workflows/build.yml` runs `bun run env:verify` on every PR. Because the job's own `bun install` is non-frozen, the manifest's `bun install --frozen-lockfile` is what actually catches lockfile drift here; it also fails on a broken/unparseable manifest, a missing declared toolchain, or a broken readiness command — before any of it reaches an agent. Root `env:verify` script added for humans too.
4. **Secret contract** ✅ *shipped* — the gate now runs inside `startSession` against the **fully-assembled worker env** (`cleanEnv`: server creds + connector env + role secrets), not raw `process.env`. So `env.required` is validated against exactly what the agent will see, and a secret that wasn't delivered — because it's unset, or the claim-time refresh failed and the server omitted it — fails the gate cheaply with a diagnosable reason. Scoping precedence and proactive expiry refresh stay server-side (claim route + `codex-token-refresh` cron), which is their correct home; the runner-side gate deliberately does presence-of-injected-value, turning "missing/omitted/failed-refresh" into a first-class provision failure. *Not covered:* a present-but-stale value the server didn't catch — that remains a runtime auth-failure + credential-health concern, out of scope for a presence gate.

## Open questions

- **Caching / warm base:** *(partly done)* the gate now has a **warm cache** — because it runs before the agent modifies the tree, an env-independent manifest's pass is a pure function of (base commit + manifest), so repeat tasks off the same base on a runner reuse it (skipping a possibly-expensive readiness probe) with a 10-min TTL; only passes, only env-independent manifests, keyed by commit. **Still open:** the `bun install` cost itself — bun already hardlinks from its global cache, so a custom install/node_modules cache is deferred (past `node_modules`-sharing incidents make it high-risk for modest gain).
- **Auto-detection fidelity:** how far can we get with zero manifest before a repo *must* declare one?
- **Failure taxonomy:** *(partly answered)* a provision block now emits a stable `ProvisionFailureCode` (`provision_toolchain_missing` / `_install_failed` / `_env_missing` / `_setup_failed` / `_readiness_failed`) + failing phase, carried to the worker record as `resultMeta.provisionFailure`. **Still open:** how the organizer/server *acts* on each code — retry-once (e.g. flaky readiness) vs. escalate (missing secret) vs. mark blocked — and where a bounded retry counter lives so a broken manifest can't loop.
- **Relationship to `gitConfig.sandbox`:** does provisioning run inside or outside the sandbox boundary?
