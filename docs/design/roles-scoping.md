# Roles Scoping Model

## Overview

A **role** is a `workspaceSkills` row with `isRole: true`. Roles define agent personas — model preference, tool access, delegation rules, and instructions. They can be scoped in two ways:

- **Team-level (default)**: `workspaceId IS NULL`. Applies to every workspace in the team. One row covers all.
- **Workspace-scoped**: `workspaceId` is set. Applies to exactly one workspace. Used for workspace-specific overrides or standalone workspace roles.

## Scoping Semantics

### Team-level roles

A team-level role (`workspaceId = NULL`) is the canonical definition of that role for the team. When a runner in any workspace claims a task with `roleSlug = 'builder'`, the team-level `builder` role provides the instructions, model, and tool config.

### Workspace overrides

A workspace-scoped row with the same slug as a team-level row is an **override**. It inherits from the team default and may override specific fields (`content`, `allowedTools`, `mcpServers`). The effective role for a given workspace is:

```
effective = workspace_override ?? team_default
```

### Workspace-only roles (no team default)

A workspace-scoped row with a slug that has no team-level counterpart is a **standalone workspace role**. It behaves like a team role but is only visible to that workspace's runners.

## Name-Uniqueness Rules

Slug uniqueness is enforced within a team+scope combination:

- Two team-level rows in the same team **cannot** share a slug.
- A workspace-scoped row may share its slug with the team-level row (that makes it an override).
- Two workspace-scoped rows in **different** workspaces of the same team **may** share a slug (and often will — e.g. every workspace having its own `builder`).

This means duplicate names **are allowed** across workspaces. When they exist, every surface that displays role names outside that role's own workspace context **must** add workspace qualification so the user can distinguish them.

## Delegation Across Workspace Boundaries

The `canDelegateTo` field is a list of role slugs. At runtime, when role A delegates to slug `builder`, the system resolves `builder` for the task's workspace (workspace override first, team default fallback). This means delegation always resolves to the effective role for the task's workspace — cross-workspace delegation is not directly addressable by slug.

## Display Contract

Wherever a role name appears **outside its own workspace context**, it must be rendered with workspace qualification to disambiguate duplicate names:

| Surface | Required format |
|---------|----------------|
| Delegation picker chips | `workspaceName/RoleName` when any name is duplicated; bare name when unique |
| Team tab role list | Scope badge (`All workspaces` or `workspaceName`) on every card/chip |
| Role detail page header | Scope badge (`All workspaces` or `Scoped to: workspaceName`) near the title |
| Role editor header | Scope badge (`All workspaces` or `Scoped to: workspaceName`) near the title |
| Task assignment (future) | `workspaceName/RoleName` when name is ambiguous in the selection context |
| Activity feed (future) | `workspaceName/RoleName` when name is ambiguous across the visible scope |

### Scope badge rendering

```
Team-level:      [team-icon] All workspaces      (accent colour)
Workspace:       [house-icon] buildd-ios          (muted colour)
```

Selected state on delegation chips must remain readable (white fill on dark background) regardless of the added workspace qualifier.

## Migration Note

Legacy workspace-scoped roles that have no team-level counterpart appear in the Team tab under `wsOnlyRoles`. Their `scopeLabel` already resolves to the workspace name. The Team tab's `ScopeBadge` component handles this correctly. The fixes required are:

1. Add workspace qualification to the delegation picker in `TeamRoleEditor` (and `RoleEditor` for future parity).
2. Add the scope badge to the role detail page header (`/app/team/[slug]`).
3. Add the scope badge to the workspace role editor header (`RoleEditor.tsx`).
