# Skills Feature: Is It Overthought?

## TL;DR

Yes. The current implementation has 3 distinct delivery mechanisms (scan+sync, API install, runtime injection), a full CRUD dashboard, and CLI tooling -- for something that every other tool in the market solves with **committed markdown files in the repo**. The core insight is correct: public skills belong in `.claude/`, private skills need server-side injection. But the machinery around it is overbuilt.

---

## What Everyone Else Does

### The Universal Pattern: Committed Files

**Every single AI coding tool** (Claude Code, Cursor, Windsurf, Copilot, Aider, Cline, Continue) converges on the same approach:

| Tool | Committed Location | Format |
|------|-------------------|--------|
| Claude Code | `.claude/skills/<name>/SKILL.md`, `CLAUDE.md` | Markdown + YAML frontmatter |
| Cursor | `.cursor/rules/*.mdc` | Markdown + YAML frontmatter |
| Windsurf | `.windsurf/rules/*.md` | Markdown |
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | Markdown + YAML frontmatter |
| Aider | `CONVENTIONS.md` | Markdown |
| Cline | `.clinerules/` | Markdown |
| Continue | `.continue/rules/*.md` | Markdown |

**Key insight**: Nobody has a server-side skill injection API. Nobody stores skills in a database for runtime delivery. The industry answer is: **commit it to the repo**.

### The Privacy Layers

Every tool also supports private/local instructions:

| Layer | How | Shared? |
|-------|-----|---------|
| **Repo-committed** | `.claude/skills/`, `CLAUDE.md` | Yes, all contributors |
| **User-local** | `~/.claude/CLAUDE.md` | No, per-machine |
| **Gitignored-local** | `.claude/CLAUDE.local.md` | No, but project-scoped |
| **Enterprise-managed** | Server-pushed policies | Org-wide (Claude Enterprise, Copilot Enterprise) |

### What's NOT Happening

- No tool injects skills per-task from a server database
- No tool has a skill marketplace or registry
- No tool has install/link/sync CLI commands for skills
- No tool re-transmits skill content on every task claim

---

## Cross-Tool Comparison Matrix

| Feature | Claude Code | Cursor | Windsurf | Copilot | Aider | Cline | Continue |
|---------|------------|--------|----------|---------|-------|-------|----------|
| Committed repo rules | CLAUDE.md | .cursor/rules/ | .windsurf/rules/ | .github/copilot-instructions.md | .aider.conf.yml | .clinerules/ | .continue/rules/ |
| User/private rules | ~/.claude/CLAUDE.md | Settings UI | global_rules.md | VS Code settings | ~/.aider.conf.yml | Global .clinerules/ | ~/.continue/config.yaml |
| Org/enterprise tier | Enterprise managed | No | No | Org-level (Enterprise) | No | No | No |
| File-scoped (globs) | No (subdirectory only) | Yes | Yes | Yes | No | No | No |
| Auto-invocation by AI | Yes | Yes (auto-attach) | Yes (model-requested) | No | No | No | Yes |
| Slash commands/skills | Yes (SKILL.md) | No | No | No | No | No | Yes (prompts) |
| AI-editable rules | No | No | No | No | No | **Yes** | Yes |
| Hard character limits | None | None | 6K/file, 12K total | None | None | None | None |

---

## What Buildd Currently Does (The Complexity)

### 3 Delivery Mechanisms

1. **Local scan + sync**: Runner scans `.claude/skills/` in repo, syncs to workspace DB via `/api/workspaces/[id]/skills/sync`
2. **API registration**: MCP `register_skill` or dashboard UI creates skills in `workspaceSkills` table
3. **Runtime injection**: On task claim, worker receives `skillBundles[]` with full content, writes to `~/.claude/skills/<slug>/SKILL.md`

### Supporting Infrastructure

- Full DB table (`workspaceSkills`) with slug, content, contentHash, source, enabled, origin, metadata
- REST API: 6+ endpoints (list, create, get, update, delete, sync, install)
- Dashboard page with usage stats (recentRuns, totalRuns)
- CLI commands: `buildd skill install|link|unlink|register|list`
- Pusher events for remote installation
- SkillBundle type with referenceFiles
- SkillPills + SkillSlashTypeahead UI components
- Content hashing for idempotent sync
- Skill-as-subagent mode (`useSkillAgents`)

That's a LOT of surface area for what is essentially "give the agent some extra instructions."

---

## The Core Flow (What It Should Be)

### Two legitimate use cases:

**1. Public skills (all workers see them)**
-> Just commit to `.claude/skills/` in the repo. Done. This is what Claude Code natively supports. No Buildd infrastructure needed.

**2. Private/team skills (not in repo, managed centrally)**
-> Buildd stores in DB, injects once into the worker's local `~/.claude/skills/` directory, gitignored. This is the **actual differentiator** -- no other tool does this.

### Simplified Architecture

```
Public skill:     commit .claude/skills/foo/SKILL.md -> Claude reads natively -> done
Private skill:    Buildd DB -> inject on first claim -> ~/.claude/skills/foo/SKILL.md -> done
```

That's it. Two paths, one outcome: a SKILL.md file on disk that Claude reads natively.

---

## What to Cut

| Current Feature | Verdict | Reasoning |
|----------------|---------|-----------|
| `workspaceSkills` DB table | **Keep** (for private skills) | This is the differentiator |
| Runtime injection on claim | **Keep but simplify** | Only inject if not already present (check hash) |
| Local scan + sync to DB | **Cut** | If it's in the repo, Claude reads it directly. No need to mirror to DB. |
| `buildd skill install` CLI | **Cut** | `git clone` or copy the file. Skills are markdown files, not packages. |
| `buildd skill link` CLI | **Cut** | Symlinks for development of... markdown files? Overkill. |
| Dashboard skill management page | **Simplify** | Keep for private skills only. Remove usage stats (derive from task data). |
| Pusher-based remote installation | **Cut** | Write the file on claim. No push notifications needed. |
| SkillPills / SkillSlashTypeahead | **Simplify** | Only show private/workspace skills (public ones are in the repo already). |
| Skill-as-subagent mode | **Keep** | Genuine value-add for complex workflows. |
| Content hashing | **Keep** | Cheap idempotency check. |
| `register_skill` MCP action | **Keep** | How private skills get into the DB. |

---

## Recommended Approach

### Phase 1: Clarify the Mental Model

Document and communicate:
- **Public skills** = committed to `.claude/skills/` = Buildd doesn't touch them
- **Private skills** = stored in Buildd DB = injected on first run = gitignored
- That's the whole feature

### Phase 2: Simplify the Code

1. Remove local scan -> DB sync (skills in repo don't need to be in the DB)
2. Remove CLI install/link commands (markdown files don't need a package manager)
3. Simplify injection: on claim, check if `~/.claude/skills/<slug>/SKILL.md` exists with matching hash -> skip if yes -> write if no
4. Remove Pusher skill installation events

### Phase 3: Double Down on the Differentiator

What Buildd uniquely enables that nobody else does:

1. **Workspace-scoped private skills**: Team knowledge that doesn't leak into the repo
2. **Task-contextual skill selection**: Attach specific skills to task types/categories
3. **Skill-as-subagent**: Skills that run as autonomous agents, not just instructions
4. **Cross-repo skills**: Same private skill available across multiple repos in a workspace

---

## Cost Analysis

### Current Injection Cost
Every task claim sends full skill content in the response. If a skill is 2K tokens and a worker claims 20 tasks/day with 3 skills each, that's 120K tokens/day just in skill re-transmission -- before Claude even reads them.

### Optimized Cost
With hash-based local caching: skill content transmitted once per runner lifetime (or until content changes). Ongoing cost: ~0 tokens for skill delivery. Claude still reads SKILL.md files from disk each conversation, but that's native Claude Code behavior regardless.

### The Real Expense
The expensive part isn't injection -- it's Claude reading the SKILL.md files into context every conversation. This happens whether Buildd injects them or they're committed to the repo. The solution is **relevance filtering** (only attach skills that match the task), which Buildd already does via `skillSlugs` on tasks.

---

## Industry Trend Summary

| Trend | Direction | Buildd Alignment |
|-------|-----------|------------------|
| Committed markdown files | Universal standard | Aligned (don't fight this) |
| YAML frontmatter for metadata | Converging | Aligned |
| Glob/path scoping | Growing (Cursor, Copilot, Windsurf) | Not implemented (low priority) |
| Enterprise server-managed policies | Emerging (Claude, Copilot) | Buildd's private skills = this for teams |
| AI-editable rules | Emerging (Cline, Continue) | Not implemented (interesting but niche) |
| Skills marketplace | Nobody has this yet | Don't build it yet |
| Runtime per-task injection | Nobody does this | Buildd's differentiator |

---

## Bottom Line

The skills feature tries to be three things:
1. A package manager for markdown files (unnecessary)
2. A sync engine between repo and database (unnecessary)
3. A private skill store with task-contextual injection (the actual value)

Strip it down to #3. Let Claude Code handle #1 and #2 natively. Focus engineering effort on what makes Buildd unique: **centrally managed, workspace-scoped, task-contextual skill injection for team-private knowledge.**
