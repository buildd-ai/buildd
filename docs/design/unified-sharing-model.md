# Unified Team/Workspace Sharing Across Credentials, Connectors & Roles

**Status:** Proposed
**Related:** `apps/web/src/app/app/(protected)/settings/AgentBackendsSection.tsx`, `apps/web/src/app/app/(protected)/connections/{ConnectionsClient,AddConnectionModal}.tsx`, `apps/web/src/app/api/connectors/route.ts`, `packages/core/db/schema.ts` (`secrets`, `connectors`, `connectorWorkspaces`, `connectorShares`, `workspaceSkills`), `docs/credentials-architecture.md`

## Problem

buildd has three "who can use this?" surfaces, each with a **different sharing model and UX** — so users can't reason about scope consistently. Observed (2026-07-20): a user connected the **Cue** connector and reported *"it's auto across all teams. Feels odd. During creation that wasn't clear. And it's a different sharing experience vs [the agent-backend] OAuth."*

| Surface | Scope storage | When scope is chosen | UI |
|---|---|---|---|
| **Agent-backend credentials** (`secrets`) | `teamId` + optional `workspaceId` (+ `accountId`) on the row; all-teams = one row per team | **at creation** | "Applies to: This team / One workspace / All my teams" segmented control |
| **Connectors** | team-owned (`connectors.teamId`); per-workspace via `connectorWorkspaces`; cross-team via `connectorShares` | **after** creation (separate "Sharing" action); add-modal shows **nothing** | "Sharing" button → per-team share picker |
| **Roles** (`workspaceSkills`, `isRole`) | `teamId` + optional `workspaceId`; mount connectors via `connectorRefs[]` | at role edit | Team page role editor |

Concretely wrong today:
- The **Add Connection** modal exposes no scope, so after connecting you can't tell who it reaches (it's the owning team's workspaces — but that's invisible).
- Connectors say "share with a team"; credentials say "This team / One workspace / All my teams" — **different vocabulary for the same idea**.
- Roles reference connectors (`connectorRefs`) but the role editor doesn't surface the shared-connector concept as a first-class, consistent thing.

## Proposal

Unify at the **concept + UX layer**, not with a storage migration. Define one **Scope** vocabulary and one reusable control, and make all three surfaces speak it:

**Scope = { level: 'workspace' | 'team' | 'all-teams', workspaceId? }**, with consistent resolution precedence everywhere: **workspace-scoped ⟶ team-wide ⟶ (cross-team share)**.

1. **Shared `<ScopeSelector>` component** — extract the agent-backend "Applies to" control into a reusable component and use it in: the credential cards (already), the **Add Connection** modal, the connector **Sharing** panel, and the role editor's connector section.
2. **Connectors adopt scope at creation** — the Add Connection modal shows the scope up-front ("Available to all workspaces in <team> · share with other teams later"), and the connector card shows its current reach instead of a bare "Sharing" button.
3. **Roles fully express the shared-connector concept** — the role editor lists team connectors with the same scope language, and a role's `connectorRefs` visibly inherits/needs the connector's scope (a role can only mount a connector that's in scope for the role's team/workspace).
4. **Consistent language** everywhere: "This team (all workspaces)", "One workspace", "All my teams".

**Crux:** the three storage models don't match — credentials use a `workspaceId` column (single), connectors use a `connectorWorkspaces` join (many), roles use a `workspaceId` column + `connectorRefs`. The unification must be a **presentation/semantics layer over the existing storage** (a `Scope` type + mappers per surface), NOT a schema merge. If we try to force one physical model, we break the connector many-workspace mount and the credential precedence — so the shared thing is the *concept and component*, and each surface keeps its storage with a thin adapter.

## Phasing

- **Phase 1 (this PR):** extract `<ScopeSelector>`; make the connector Add modal + card show scope/reach in the shared vocabulary (fixes the reported confusion). No storage change.
- **Phase 2:** role editor surfaces connectors with the shared scope language; validate that a role only mounts connectors in scope for its team/workspace.
- **Phase 3 (optional):** connector "All my teams" fan-out parity with credentials (share to every team in one action), if desired.

## Current state (cite)

- `secrets`: `teamId` + `workspaceId?` + `accountId?`; scope UI in `AgentBackendsSection.tsx` (`Scope = 'team' | 'workspace' | 'all_teams'`).
- `connectors` + `connectorWorkspaces` (mount) + `connectorShares` (cross-team); UI in `ConnectionsClient.tsx` / `AddConnectionModal.tsx`; API `/api/connectors`.
- `workspaceSkills` (roles): `teamId` + `workspaceId?` + `connectorRefs[]`.

## Open questions

- **`connectorWorkspaces` vs single `workspaceId`.** Connectors mount to *many* workspaces; credentials scope to *one*. Lean: keep connectors' many-mount, and map "One workspace" in the shared control to a single `connectorWorkspaces` row (with an "add more workspaces" affordance) — don't force credentials to become many-workspace.
- **Cross-team sharing for credentials.** Credentials do all-teams via fan-out (a row per team); connectors do it via `connectorShares` (one row, referenced). These stay different physically; the UI says "All my teams" for both. Acceptable, or converge later (Phase 3)?
- **Account-scoped credentials.** `secrets.accountId` has no analogue in connectors/roles. Lean: leave it out of the shared control (it's a rarely-used niche), keep it in the credential resolver only.

## Non-goals

- Merging the three storage models into one table.
- Changing resolution precedence or the existing claim-time behavior.
- Reworking the connectors↔roles `connectorRefs` mechanism (roles already mount connectors that way).
