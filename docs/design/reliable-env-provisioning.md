# Reliable Environment Provisioning

**Status:** design proposal (2026-07-18). No implementation yet.
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

1. **Verifier core** — manifest parser + phase runner + `buildd env verify` CLI. Auto-detection for the no-manifest case so existing repos get value with zero config.
2. **Runner integration** — call the verifier as the provision phase in `setupWorktree`; on failure, requeue with a structured reason instead of spending agent budget.
3. **CI check** — run the verifier on PRs to catch bootstrappability regressions.
4. **Secret contract** — wire `env.required` to the `secrets` table scoping precedence; surface missing/expired secrets as a first-class provision failure.

## Open questions

- **Caching / warm base:** how much of provisioning can be cached across worktrees on the same runner to keep the phase fast? (The install is already the slow part.)
- **Auto-detection fidelity:** how far can we get with zero manifest before a repo *must* declare one?
- **Failure taxonomy:** what structured reasons does a provision failure emit, and how does the organizer act on them (retry vs. escalate vs. mark blocked)?
- **Relationship to `gitConfig.sandbox`:** does provisioning run inside or outside the sandbox boundary?
