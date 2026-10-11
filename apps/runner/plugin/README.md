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

Once a Claude Code session has claimed a task, `touch` and `end` also carry its
token usage, so the task's cost counts work done from your own session. The
hook reads the new lines of the session's own local transcript files and keeps
only each API call's message id, model id, token counts, timestamp and number
of tool calls; message text and tool inputs and outputs are never kept or sent.
A subagent that claimed a task has its usage counted on that task.
The usage also says how it was charged, as one word: `real` (an API key, bearer
token, cloud provider or gateway), `virtual` (a subscription login) or
`unknown`, worked out from your environment and Claude Code config in Claude
Code's own credential order; no key or config value is sent.
`BUILDD_HOOK_USAGE=0` turns this off.

The contract and server behaviour are specified in
`docs/specs/local-agent-presence.md` in the buildd repo.

## Install

**With the buildd CLI** (recommended; installs hooks + skill for every
detected client, no credential in any hook file). No runner needed: the
client-only install is enough (`curl -fsSL https://buildd.dev/install.sh | bash -s -- --client`).

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
folder, for the folders Claude Code has opened whose repo is a workspace in
any team you are in (your presence token's list, from `buildd login`).
Re-run it after a new checkout, or use `--here` in any folder.

Your login key belongs to one team. A folder whose workspace that team cannot
reach always gets the key-free OAuth entry below, never the key: a key entry
there would shadow the folder's own `.mcp.json` with a key that cannot see the
workspace. Re-running switches any such key entry to OAuth and says which
folders it changed; `--status --global` flags one it finds. Without a presence
token (an older login) only the key's team is covered, and install says so.

With `--oauth` (opt-in) no key is written for those folders. There are two
kinds of connection:

- **As you** (`--oauth`): what the connection does is done as you, with your
  role in each workspace's team. Use it on your own machine.
- **As your agent** (`--as-agent`): the connection acts as your agent, not as
  you. Use it on a shared or remote machine.

When the server offers one connection across workspaces, every folder points
at `<server>/api/mcp`. Claude Code signs you in in the browser the first time
(`/mcp` shows the state) and you pick the workspaces it reaches on the consent
page. For an as-you connection the entry pins Claude Code's requested scopes
(`"oauth": { "scopes": "buildd:read buildd:write buildd:act-as-person" }`);
the server never advertises `buildd:act-as-person`, so only an entry that names
it asks to act as you. An as-your-agent entry pins nothing. Install checks for
the one connection by asking `<server>/api/mcp` without a key: an OAuth
challenge naming that resource's metadata means yes. On a server without it,
each folder points at its own workspace's endpoint,
`<server>/api/mcp-oauth/<workspaceId>`, and who it acts as is decided when you
sign in.

Re-running replaces a key entry the installer wrote; a folder's own `.mcp.json`
is never touched. A `--here --oauth` folder that is not a workspace yet keeps
the key until it is, unless the server offers the one connection, which needs
no workspace. `buildd install --global --status` lists every buildd entry:
key or OAuth, and for OAuth "as you", "as your agent", or "unknown until
signed in" (a per-workspace entry, decided at sign-in). It reads only the
entries, never the network. Runner agents are unaffected: they keep using
their per-task tokens.

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
| `BUILDD_HOOK_USAGE=0` | Don't read or report session token usage |
| `BUILDD_HOOK_DEBUG=1` | Log hook decisions to stderr |
