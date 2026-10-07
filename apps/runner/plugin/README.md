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
buildd install --global          # MCP for your workspace folders + hooks; or `buildd install` inside one repo
buildd install --here            # MCP for this folder too, e.g. to set up a new workspace
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

## Scope

The hooks report a session only when it is opened in a git repo that is one of
your workspaces (checked locally against a cached list of your workspace repos,
`~/.buildd/workspace-repos-<key>.json`, refreshed by `buildd install` and at
most every 10 minutes when an unknown repo starts), in a repo whose own
`.mcp.json` names a buildd server, or when the session claims a buildd task.
Anywhere else they send nothing, not even the folder name. If the list cannot
be loaded they send nothing.

`buildd install --global` registers the buildd MCP server the same way: per
folder, for the folders Claude Code has opened whose repo is a workspace.
Re-run it after a new checkout, or use `--here` in any folder.

With `--oauth` (opt-in) no key is written for those folders: each one points
at its workspace's OAuth MCP endpoint, `<server>/api/mcp-oauth/<workspaceId>`,
and Claude Code signs you in in the browser the first time the folder uses
buildd (`/mcp` shows the state). You act as yourself, with your role in that
workspace's team, so folders from different teams each sign in to their own.
Re-running replaces a key entry the installer wrote; a folder's own `.mcp.json`
is never touched. A `--here --oauth` folder that is not a workspace yet keeps
the key until it is. `buildd install --global --status` lists every buildd
entry and whether it uses the key or OAuth.

## Credential

`buildd login` saves a **presence token** for you (`presenceToken` in
`~/.buildd/config.json`, one per machine) next to the API key, and the hooks
send that. It covers every team you are in, so a claim made with another team's
key or over OAuth still binds and is released on exit. It can only report
presence, read your workspace repos and bind or release your own interactive
workers; every other buildd route refuses it. `buildd logout` revokes it. A
config without one (an older login) falls back to the API key.

## Configuration

| Variable | Effect |
|---|---|
| `BUILDD_PRESENCE_TOKEN` | Override the saved presence token |
| `BUILDD_API_KEY`, `BUILDD_SERVER` | Override `~/.buildd/config.json` |
| `BUILDD_HOOKS_DISABLED=1` | Hooks do nothing (MCP-only mode) |
| `BUILDD_HOOK_DEBUG=1` | Log hook decisions to stderr |
