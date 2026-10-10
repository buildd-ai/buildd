# Connecting an MCP app to buildd

One connection reaches every workspace you choose, in any of your teams. You sign
in once, pick the workspaces, and the app works in each of them. You can change
the list or revoke the connection later in Settings.

Operators: see [mcp-connect-operators.md](mcp-connect-operators.md).

## The address

Use one address for every workspace:

```
https://<your-buildd-host>/api/mcp
```

On buildd.dev that is `https://buildd.dev/api/mcp`. You do not need a workspace id
in the address.

## Connect

1. Add the address to your app (Claude Code, Claude, ChatGPT, or any MCP client
   that supports OAuth sign-in).
2. The app opens buildd in your browser. Sign in if you are not signed in.
3. The consent page lists your teams and their workspaces. Choose:
   - **Workspaces.** One is ticked to start. Search, select all, or pick by team.
     You can only choose workspaces in teams you belong to.
   - **What kind of connection.** See the next section.
   - **Write.** Read access is always included. Write is ticked when the app asks
     for it, and you can untick it to make the connection read only.
4. Click **Approve**. buildd sends you back to the app and the connection is live.

**Cancel** sends the app an `access_denied` answer and creates nothing.

## Two kinds of connection

| | Agent working for you | Acts as you |
|---|---|---|
| When it is offered | Always. It is the default. | Only when the app asks for it. |
| Good for | Connectors in Claude or ChatGPT, shared or remote machines | Your own coding sessions on your own machine |
| Work is attributed to | You, recorded as your agent | You |
| Person-only actions | Refused | Allowed |

Person-only actions are the ones buildd keeps for a person, for example: marking a
PR abandoned, forcing a re-review of a head that already has a verdict, and
granting a landing override when creating a task. An agent connection gets a
clear refusal for these. Everything else works the same for both kinds.

An app asks to act as you by requesting the `buildd:act-as-person` scope. buildd
does not list that scope in its public metadata, so an app that simply asks for
everything buildd advertises still gets an agent connection. When the app does
ask, **Acts as you** is preselected and you can still pick **Agent working for
you** instead.

## Working across workspaces

When the connection reaches more than one workspace, every call has to say which
one it is for:

- The app can call the `list_workspaces` action to see the teams and workspaces
  the connection reaches, with your access level in each.
- Every other action takes a `workspaceId`: the workspace UUID, `owner/repo`, the
  repo name or the workspace name.
- A call without one is refused with `workspace_required` and the list of
  choices. buildd never guesses a default.
- A name that matches more than one of your granted workspaces is refused with
  `workspace_ambiguous` and the matching choices. Use the UUID instead.
- A workspace you did not grant, or one that does not exist, is refused with
  `workspace_not_granted`. The two read the same on purpose.
- One request acts in one workspace. A batch that names two is refused with
  `workspace_conflict`.

When the connection reaches exactly one workspace, calls need no `workspaceId`.

Each refusal is a normal tool result marked as an error, with a JSON body:

```json
{
  "error": "workspace_ambiguous",
  "message": "…",
  "choices": [{ "workspaceId": "…", "name": "…", "repo": "owner/repo", "team": "…" }],
  "hint": "list_workspaces lists every workspace this connection can act in."
}
```

The list holds only workspaces the connection reaches. It is capped, with a
`more` count when there are more.

## Claude Code: `buildd install`

The buildd CLI can write the connection into Claude Code for you:

```bash
buildd install --global --oauth      # sign in in the browser; the connection acts as you
buildd install --global --as-agent   # the same sign-in, as your agent (shared or remote machine)
buildd install --here --oauth        # only this folder; works in a folder that is not a workspace yet
buildd install --global --status     # show each folder as: key, OAuth as you, OAuth as your agent, …
```

- `--oauth` writes the `/api/mcp` address with the scopes `buildd:read
  buildd:write buildd:act-as-person`, so the consent page offers **Acts as you**.
- `--as-agent` writes the same address without pinned scopes. Claude Code then
  asks only for the advertised scopes, so the connection is an agent.
- Neither stores a key on disk. Claude Code keeps the OAuth tokens.
- Against an older server that does not offer the one connection, the installer
  falls back to the per-workspace address for each folder.

Run the CLI from your home directory or another folder, not from inside a repo
you are working in.

## Settings › Connected apps

Open **Settings › Connected apps** (under "You and your team") to see every app
you connected. Each row shows the app name, whether it acts as you or as your
agent, its workspaces, read or read-and-write, and when it was last active.

From an open row you can:

- **Add or remove workspaces.** You can only add workspaces in teams you belong
  to. You cannot remove the last one; revoke instead.
- **Switch between read and read-and-write.**
- **Make it an agent.** Turns an "acts as you" connection into an agent
  connection. Going the other way needs a fresh sign-in from the app, with the
  app asking for the person scope.
- **Revoke.** Ends the connection and all its refresh tokens.

Every change applies on the app's next request, including on an access token the
app already holds. The app does not need to reconnect.

Older per-workspace connections are listed separately, with a hint to switch.

## What happens when things change

- **You leave a team.** That team's workspaces drop out of every connection on
  the next request. The connection keeps working for your other teams. If you
  rejoin the team, they come back, because the connection still lists them.
- **You lose every team the connection reaches.** The connection stops working
  and its refresh fails. The app has to sign in again.
- **A workspace is deleted or moved to another team.** It drops out the same way.
- **New workspaces** are never added on their own. Add them in Settings, or
  reconnect.

## Older per-workspace addresses (deprecated)

Before this change each connection used a per-workspace address:

```
https://<your-buildd-host>/api/mcp-oauth/<workspace-id>
```

Those addresses are **deprecated now. A removal date will be announced.** They
keep working until then, for one workspace each, exactly as before. Their
responses carry a `Deprecation: true` header, a `Link` header pointing at
`/api/mcp`, and a notice in the server instructions.

To switch: remove the old entry from your app, add `/api/mcp`, and sign in.
For Claude Code, run `buildd install --global --oauth` again. Then revoke the old
connection in Settings if it is still listed.

## Limitations

- Access tokens last one hour. Refresh tokens rotate on every use and end 90 days
  after you signed in, however often they are used. After that the app signs in
  again.
- Reusing a refresh token that was already spent ends every token from that
  sign-in. This is theft protection; the app signs in again.
- A connection belongs to one person. It cannot be shared with a teammate.
- `list_workspaces` is not available in buildd's own chat, because a chat is
  already bound to one workspace.
- The consent page shows the name the app registered itself with, and where it
  will send you back to. buildd does not verify app names. Check the return
  address if a name looks wrong.
- Apps register with buildd by dynamic client registration. Client ID metadata
  documents (CIMD) are not supported yet.
- A workspace added in Settings in a team the connection has never been used with
  can fail with a sign-in error until the app's next token refresh (at most an
  hour). This is a known issue being fixed.
