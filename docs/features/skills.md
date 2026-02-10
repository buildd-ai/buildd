# Skills

Reusable instruction templates that standardize how agents approach tasks. Skills are verified by SHA-256 hash to guarantee every agent runs the exact same instructions.

## Overview

A skill is a directory containing a `SKILL.md` file with structured instructions for agents. Examples:

- **ui-audit** - Systematic UI review against design specs
- **code-review** - Security-focused code review with checklist
- **db-migration** - Safe migration workflow with rollback steps

Skills live on your machine at `~/.buildd/skills/` and are automatically symlinked to `~/.claude/skills/` for native Claude Code discovery. The server stores only a hash registry — never the content itself.

## How It Works

1. **Install** a skill locally (`buildd skill install`)
2. **Register** its hash with the server (`buildd skill register`)
3. **Create a task** referencing the skill by slug
4. **Worker picks up the task**, verifies local hash matches server hash, then injects the skill instructions into the agent prompt

If the hash doesn't match, the worker warns that the skill is outdated. This prevents version drift across machines.

## Installing Skills

```bash
# From GitHub
buildd skill install github:acme/ui-audit
buildd skill install github:acme/skills/code-review@v2
buildd skill install acme/ui-audit              # shorthand

# From local directory
buildd skill install ./my-skills/db-migration

# From server registry (by slug)
buildd skill install ui-audit
```

Install downloads the skill to `~/.buildd/skills/<slug>/` and creates a symlink at `~/.claude/skills/<slug>` so Claude Code can discover it natively.

## Development Workflow

When authoring skills, use `link` instead of `install` to avoid re-installing after every edit:

```bash
# Symlink a skill from your repo into ~/.buildd/skills/
buildd skill link ./my-repo/skills/ui-audit

# Edits to ./my-repo/skills/ui-audit/SKILL.md are immediately visible
# No reinstall needed

# When ready to publish the current version:
buildd skill register ui-audit

# Remove the symlink
buildd skill unlink ui-audit
```

## Registering Skills

Registration pushes the current SHA-256 hash to the server. Workers verify against this hash.

```bash
buildd skill register ui-audit
# Registered "ui-audit" with server (hash: a1b2c3d4e5f6)
```

Register after:
- Installing a new skill
- Updating a skill's content
- Finalizing changes during development

## Listing Skills

```bash
buildd skill list
```

Shows all local and server-registered skills with sync status:

```
Skills

  ui-audit         ✓ synced    a1b2c3d4e5f6
    Systematic UI review against design specifications
    github:acme/ui-audit

  code-review      ⚠ hash mismatch    b2c3d4e5f6a1
    → /Users/you/repo/skills/code-review
    Security-focused code review checklist

  db-migration     local only    c3d4e5f6a1b2
    Safe migration workflow with rollback
```

## Writing a SKILL.md

Skills follow the [Agent Skills open standard](https://agentskills.io). A `SKILL.md` file with optional YAML frontmatter:

```markdown
---
name: ui-audit
description: Systematic UI review against design specifications
---

# UI Audit

You are performing a systematic UI audit. Follow these steps:

1. Screenshot every page in the flow
2. Compare against the design spec (attached or linked)
3. Flag discrepancies with severity: critical, major, minor
4. Suggest fixes with code snippets where possible

## Checklist
- [ ] Layout matches design
- [ ] Colors and typography match
- [ ] Responsive breakpoints work
- [ ] Interactive states (hover, focus, disabled)
- [ ] Accessibility (contrast, labels, keyboard nav)
```

The `name` field in frontmatter determines the slug. If omitted, the directory name is used.

## Using Skills in Tasks

When creating a task via the API, reference a skill by slug:

```bash
curl -X POST https://buildd.dev/api/tasks \
  -H "Authorization: Bearer bld_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "ws_xxx",
    "title": "Audit checkout flow UI",
    "description": "Review the checkout pages against the latest Figma designs",
    "skillRef": { "slug": "ui-audit" }
  }'
```

The server resolves the skill, stores the hash in the task context, and workers verify it before execution.

## File Layout

```
~/.buildd/
  skills/
    ui-audit/
      SKILL.md          # Required
      examples/         # Optional supporting files
    code-review/
      SKILL.md

~/.claude/
  skills/
    ui-audit -> ~/.buildd/skills/ui-audit    # Auto-created symlink
    code-review -> ~/.buildd/skills/code-review
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `buildd skill install <source>` | Download and register a skill |
| `buildd skill link <path>` | Symlink a local skill for development |
| `buildd skill unlink <slug>` | Remove a symlinked skill |
| `buildd skill register <slug>` | Push current hash to server |
| `buildd skill list` | Show installed and registered skills |
