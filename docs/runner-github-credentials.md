# GitHub credentials for agents on self-hosted runners

**Invariant (once enforced):** an agent acts on GitHub with credentials scoped to
its task's repository. The runner gives it a short-lived GitHub App installation
token for the repo linked to the task's workspace, and refreshes it while the
session runs. The operator's own `GITHUB_TOKEN` / `GH_TOKEN` and the host's git
and `gh` credentials are not inherited.

Cloud runs already work this way: the cloud runner's egress handler adds the
token (`apps/cloud-runner/README.md`). This page covers self-hosted runners.
Spec: `docs/specs/credential-isolation.md` §3a.

## What the agent gets

With `githubCredentials.mode = 'scoped'` on the claim, the runner
(`apps/runner/src/agent-github-credentials.ts`):

- removes `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` from the agent env;
- sets git config at the command-line level (`GIT_CONFIG_COUNT`), which outranks
  system, global and repo-local files. It empties every credential helper and
  installs one that answers for `github.com` from a token file. GitHub SSH
  remotes are rewritten to https so host SSH keys are not used. Identity, LFS
  and the rest of the host git config still apply;
- points `GH_CONFIG_DIR` at a private dir whose `hosts.yml` holds the token;
- fetches the token from `POST /api/runner/agent-github-token` at session start
  and five minutes before each expiry, rewriting both files. Files live under
  the session's throwaway runner home and go away with it.

The token has the permissions in `TASK_TOKEN_PERMISSIONS`
(`apps/web/src/lib/github-scoped-token.ts`): contents, pull requests and issues
read/write; checks, actions and statuses read. It has no `workflows`
permission, so a push that changes `.github/workflows/` is refused, the same as
on cloud runs. PRs opened with `create_pr` go through the server and are
unaffected.

If the token cannot be fetched, the agent gets **no** GitHub credential (fail
closed). Its prompt tells it to report blocked, and the worker shows a
`GitHub: no credentials (...)` milestone with the reason.

## Opt-out: workspaces without the GitHub App

A workspace whose repo is not linked through the buildd GitHub App has nothing
to mint a token from. To keep using the runner's own credentials, opt out
explicitly:

```
buildd action=manage_workspaces params={ action: "update", workspaceId: "<ws>",
  gitConfig: { agentGitHubCredentials: "runner" } }
```

`runner` is the only value it accepts. Anything else, or no value, means
task-scoped. Remove the opt-out once the App is installed and the repo linked.

## Migration

- **No database migration.** `agentGitHubCredentials` is a field in the
  existing `workspaces.git_config` JSON.
- **Runners:** the behaviour ships in the runner build that sends the
  `scoped_github_token` feature on its claims. An older runner never gets the
  marker and keeps passing its own credentials through, so upgrading runners
  first loses nothing.
- **Operators** can leave `GITHUB_TOKEN` / `gh auth` on the host: the runner
  still uses them for its own clones and fetches. They stop reaching the agent.

## Rollout

The server env var `AGENT_GITHUB_TOKEN_ROLLOUT` sets the stage
(`packages/core/agent-github-credentials.ts`):

| Value | Effect on claims from runners with the feature |
|---|---|
| unset / `off` | No change. Every agent inherits as before. |
| `linked` | Scoped for workspaces with a linked GitHub App repo; others unchanged. |
| `enforce` | Scoped for every workspace except those that opted out. |

The opt-out applies in both `linked` and `enforce`.

1. **Ship with the flag off.** Runners update and start declaring the feature.
   Check with `list_runners` that the runners serving each workspace are on the
   new build.
2. **Check prod before `linked`.** For each workspace that self-hosted runners
   claim from, confirm the GitHub App installation is linked and not
   suspended, and that its permissions include contents and pull requests
   write.
3. **Set `linked`.** Watch for `GitHub: no credentials` milestones, failed
   pushes and `agent-github-token` 4xx/5xx in the server logs. Roll back by
   unsetting the variable; it takes effect on the next claim.
4. **Before `enforce`,** list the workspaces self-hosted runners claim from that
   have no linked repo. Link the App, or set the opt-out on each one.
5. **Set `enforce`.** Any workspace missed in step 4 shows
   `Workspace has no linked GitHub repository` on its next task; link it or opt
   it out.

## Known limits

- **Codex tasks:** the Codex subprocess holds the runner API key (spec §3 AC-6),
  so a Codex agent could ask for a token for another live worker of the same
  account. That token is still repo-scoped and short-lived.
- **Private dependencies on other GitHub repos** fetched over https during the
  dependency install or by the agent no longer use the operator's credentials.
  Vendor them, or opt the workspace out.
- **Files on disk:** this controls what git, `gh` and the env hand the agent.
  Reading host credential files directly is a filesystem question for the
  sandbox (`docs/specs/worker-sandbox-isolation.md`).
