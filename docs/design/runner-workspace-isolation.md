---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "isolated-workspace-root"
    type: "symbol"
    name: "isolatedWorkspacePath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped Tier 3 isolation; kept suppressed alongside isolated-claude-home and isolated-codex-home because Tier 4 (separate UID/container per tenant) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
  - id: "isolated-claude-home"
    type: "symbol"
    name: "isolatedClaudeConfigDirPath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped Tier 3 isolation; kept suppressed alongside isolated-workspace-root and isolated-codex-home because Tier 4 (separate UID/container per tenant) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
  - id: "isolated-codex-home"
    type: "symbol"
    name: "stableCodexHomeIsolatedPath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Assertions here only cover shipped Tier 1 (API key removal) and Tier 3 (per-workspace clones) isolation; Tier 4 (separate UID/container per tenant, closing the /proc/self/environ and world-readable-path read boundary) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
---

# runner-workspace-isolation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/runner-workspace-isolation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
