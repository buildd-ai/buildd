# buildd agent plugin

Makes an interactive coding session (Claude Code, Codex, Cursor) a first-class
buildd presence. It bundles:

| Part | File | Portable? |
|---|---|---|
| Manifest (Agent Plugins 1.0) | `plugin.json` | yes |
| buildd MCP server | `mcp.json` (Claude Code: inline in `.claude-plugin/plugin.json`) | yes |
| Session skill | `skills/buildd-session/SKILL.md` | yes |
| Lifecycle hooks (client extensions) | `hooks/hooks.json` (Claude Code), `com.openai.codex/hooks.json`, `com.cursor/hooks.json` | per client |
| Hook script | `scripts/buildd-hook.mjs` | Node 18+ or Bun, no dependencies |

MCP stays the control plane: claiming, progress, notes, PRs and completion all
go through the buildd MCP tool. The hooks only send four typed events to
`POST /api/workers/local-sessions` — `start`, `touch` (at most once a minute),
`bind` (after this session's own `claim_task` succeeds) and `end`. They never
send prompts, responses, reasoning, transcripts or secrets, and they always
exit 0: if buildd is down the agent carries on.

The contract and server behaviour are specified in
`docs/specs/local-agent-presence.md` in the buildd repo.

## Install

**With the buildd CLI** (recommended; installs hooks + skill for every
detected client, no credential in any hook file):

```bash
buildd login
buildd install --global          # or `buildd install` inside one repo
buildd install --status --global
buildd install --uninstall --global
```

Uninstall removes only handlers whose command names `buildd-hook.mjs`; every
other hook and setting is preserved.

**As a Claude Code plugin** (marketplace in the buildd repo root):

```bash
export BUILDD_API_KEY=bld_...
claude plugin marketplace add buildd-ai/buildd
claude plugin install buildd@buildd
```

Use one route or the other: the plugin brings its own MCP entry, so do not
also keep a `buildd` entry from `buildd install --global` in `~/.claude.json`.

**Codex** asks you to trust each new hook before it runs. Review them with
`/hooks` after installing; nothing here pre-trusts them.

**Cursor** project hooks resolve commands from the project root; the CLI
writes absolute paths, so prefer it over copying `com.cursor/hooks.json`.

## Configuration

| Variable | Effect |
|---|---|
| `BUILDD_API_KEY`, `BUILDD_SERVER` | Override `~/.buildd/config.json` |
| `BUILDD_HOOKS_DISABLED=1` | Hooks do nothing (MCP-only mode) |
| `BUILDD_HOOK_DEBUG=1` | Log hook decisions to stderr |
