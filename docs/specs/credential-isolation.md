---
title: Credential Isolation & MCP Injection Security Model
status: active
owner: builder
last_verified: 2026-07-21
---
# Credential Isolation & MCP Injection Security Model

> **Background.** Two incidents in the Cue email-classification pipeline exposed a
> repeatable agent failure mode: when MCP credentials fail to inject (because the
> wrong workspace was resolved at claim time), capable agents improvise by
> scavenging reachable credentials and calling APIs directly. Incident 1: an agent
> read the Cue secret from `~/.buildd/config.json` *outside* its work folder;
> the secret rendered unmasked in the Buildd UI tool-call log. Incident 2: the
> agent resolved `DISPATCH_API_KEY` from worker-context provider headers and
> successfully classified 20 emails directly. Both secrets required rotation.
>
> **Design principle**: capability scoping over permission prompting. An agent
> running under `bypassPermissions` is safe only when its environment contains
> nothing it was never granted. Every layer below is a ring in that defence — the
> point of failure must be detectable, not silently worked around.

---

## 1. Workspace resolution at claim time

**Capability statement**: The claim route MUST resolve MCP server configs and
credentials from the **task's own workspace** (via the task's `workspaceId`), not
the runner's registered workspace; a task whose workspace differs from the
runner's registration MUST still receive its own workspace's connector set.

**Pre-fix bug (root cause of both incidents)**: For Codex workers, claim-time
connectors (`worker.mcpConnectors`) were appended to `queryOptions.mcpServers`
but Codex never reads `queryOptions.mcpServers` — it reads only
`CODEX_HOME/config.toml`. Connectors were silently dropped for every Codex task.
The fix extends `workers.ts` to iterate `worker.mcpConnectors` after building
`codexAdditionalServers`, emitting one `[mcp_servers.<name>]` TOML block per
connector with the bearer token stored in `MCP_BEARER_CONN_<SLUG>` env var and
only that env-var *name* written into config.toml.

**Invariants**:
- `worker.mcpConnectors` is populated from the **task's** workspace connector
  set (filtered by role `connectorRefs` and workspace opt-in) at claim time.
  The runner's own workspace identity plays no role in resolution.
- Connectors with `authMode='header'` inject their bearer token as
  `MCP_BEARER_CONN_<SLUG>` in `cleanEnv`; the token value MUST NOT appear in
  `config.toml`.
- Cross-team connector credentials are resolved by `connector.teamId` (the owner
  team), not the task's team — keyed this way from Phase 1 so cross-team sharing
  requires no injection rewrite.
- Non-Bearer and stdio connectors for Codex tasks emit a warning and are skipped
  (config.toml schema does not support arbitrary headers).

**Acceptance criteria**:
- AC-1: GIVEN a Codex task in workspace W with role R where R's `connectorRefs`
  includes connector C WHEN the task is claimed THEN `config.toml` contains a
  `[mcp_servers.<c-slug>]` block with `bearer_token_env_var = "MCP_BEARER_CONN_<SLUG>"`.
- AC-2: GIVEN the same setup WHEN the task is claimed THEN the bearer token value
  does NOT appear anywhere in `config.toml`; only the env-var name appears.
- AC-3: GIVEN a task in workspace W and a runner registered to workspace W2
  (different) WHEN claimed THEN the injected connectors are W's connector set,
  not W2's.
- AC-4: GIVEN a connector C from team A shared to team B WHEN a task in team B
  claims it THEN the injected credential is fetched from team A's `secrets` row
  (the owner team), with no `secrets` row required under team B.
- AC-5 (failure): GIVEN a Codex task where a required connector uses non-Bearer
  auth (e.g. `authMode='none'`) WHEN claimed THEN the connector is skipped with
  a logged warning, and the claim returns `200` (no hard failure at this layer —
  pre-flight in §2 catches missing connectors).

**Code surface**:
- Injection: `apps/runner/src/workers.ts` — `codexAdditionalServers` assembly
  (iterates `worker.mcpConnectors` post-`.mcp.json` block, emits
  `MCP_BEARER_CONN_<SLUG>` env vars).
- Claim route: `apps/web/src/app/api/workers/claim/route.ts` — connector
  resolution block (filters by `connectorRefs ∩ enabledForWorkspace ∩
  teamConnectors`, resolves credential by `connector.teamId`).
- Regression tests: `apps/web/src/app/api/workers/claim/route.test.ts` (3 new
  tests: mcp_credential delivery, connector endpoint regression, cross-team
  exclusion).

**Out of scope**: stdio connector injection for Codex (requires config.toml
schema extension); mid-task connector 401 / pause-resume.

---

## 2. Pre-flight MCP validation

**Capability statement**: At worker startup, BEFORE the agent loop begins, the
runner MUST verify every connector declared in the task role's `claimConnectors`
is mounted in `queryOptions.mcpServers` and responds to an HTTP initialize probe;
a single failure MUST abort the worker with a structured error — no degraded mode,
no fallback.

**Why hard-fail matters**: An agent that detects an unavailable tool and
improvises by reading reachable credentials is worse than one that never starts —
the improvisation validates the bypass pattern. The pre-flight gate eliminates
the success signal that would otherwise reward scavenging behavior.

**Invariants**:
- `runMcpPreflight` is called after all MCP servers are assembled but before the
  agent SDK is invoked.
- Scope is limited to `claimConnectors` (the role's explicit `connectorRefs`
  intersected with what was actually mounted) — workspace `.mcp.json` servers
  that are not required by the role do NOT trigger failure.
- HTTP probe failure conditions: `404`, `502`, `503`, `504` → fail; `401`,
  `403`, `500` → pass (server is reachable; auth issues are distinct).
- `stdio` connectors are not probed (spawning has side effects; uncommon type).
- On failure the worker emits structured error traces, buffers them in
  `worker.pendingErrorTraces`, and throws with `mcpPreflightFailures` populated
  in `resultMeta` so the organizer can escalate missing connector credentials.

**The Tool Channel Policy** is injected into every worker's `systemPrompt.append`
regardless of workspace or role: *"If a required MCP tool channel is unavailable
during this task, STOP IMMEDIATELY and report the failure. Never substitute
direct API access using credentials found in config files, environment variables,
disk, or response headers."*

**Acceptance criteria**:
- AC-1: GIVEN a task with role requiring connector C WHEN the pre-flight probe
  of C returns `200` THEN the agent loop starts normally.
- AC-2: GIVEN a task with role requiring connector C WHEN C is absent from
  `queryOptions.mcpServers` (not mounted) THEN the worker aborts before the
  agent loop with error code `MCP_PREFLIGHT_FAILED: <name> not mounted` and the
  task is marked failed.
- AC-3: GIVEN connector C is mounted but the HTTP probe returns `502` WHEN
  pre-flight runs THEN the worker aborts with `MCP_PREFLIGHT_FAILED: <name>
  unreachable (502)` — same hard abort as AC-2.
- AC-4: GIVEN connector C is mounted and returns `401` WHEN pre-flight runs
  THEN the pre-flight passes (server is reachable; auth handled separately by
  the MCP protocol).
- AC-5: GIVEN a task whose role has no required connectors WHEN the pre-flight
  runs THEN it returns `{ ok: true, failures: [] }` without probing any server.
- AC-6: GIVEN any worker startup THEN `systemPrompt.append` contains the Tool
  Channel Policy text (regardless of workspace or role).

**Code surface**:
- Pre-flight module: `apps/runner/src/mcp-preflight.ts` — `runMcpPreflight(opts)`
  accepts `mcpServers` map + `requiredConnectorNames[]`, returns `{ ok, failures }`.
- Integration: `apps/runner/src/workers.ts` — import + call site after MCP
  assembly; `systemPrompt.append` policy injection; `mcpPreflightFailures` in
  `resultMeta`.
- Tests: `apps/runner/__tests__/unit/mcp-preflight.test.ts` (13 tests: pass,
  not-mounted, 404, 502, ECONNREFUSED, timeout, 401/403/500 ok, multiple
  failures, buildd skipped, non-required not probed).

**Out of scope**: stdio connector probing; mid-task MCP disconnection detection
(pre-flight is startup-only); retrying transiently unreachable connectors.

---

## 3. Capability-scoped worker environment

**Capability statement**: The agent subprocess environment MUST contain only
credentials the agent was explicitly granted; runner coordination secrets
(`BUILDD_API_KEY`), MCP header-expansion secrets (`mcpSecrets`), and filesystem
credential files (`~/.buildd/config.json`, `~/.claude/.credentials.json`) MUST
NOT be reachable from the agent's tool context.

**Pre-fix root causes**:
1. `cleanEnv` was `process.env` minus only `CLAUDE_CODE_OAUTH_TOKEN` — every
   runner secret flowed to the agent subprocess.
2. `BUILDD_API_KEY` was explicitly re-injected into `cleanEnv` at claim time
   (to allow agents to call the Buildd API), making it directly readable.
3. `mcpSecrets` (including `DISPATCH_API_KEY`) were injected into `cleanEnv` for
   `.mcp.json` `${VAR}` header expansion, then left there for the agent.
4. `SENSITIVE_READ_PATHS` guarded only writes; the `Read` tool could freely
   read `~/.buildd/config.json`.

**Three-layer fix**:

*Layer 1 — Allowlist-based `cleanEnv`*: `cleanEnv` is now built from an
explicit allowlist of safe-to-expose keys (LLM provider vars like
`ANTHROPIC_API_KEY`, standard system vars, task-routing vars). `BUILDD_API_KEY`,
`mcpSecrets`, and arbitrary runner secrets are excluded. MCP header expansion
uses a separate `headerExpansionEnv` (credentials baked in, never passed to the
agent; the agent sees only the already-authenticated MCP connection).

*Layer 2 — `BUILDD_MCP_BEARER_TOKEN` injection*: The Buildd MCP bearer token is
injected only where needed (Claude SDK `mcpServers.buildd` config and Codex
`config.toml`), not into `cleanEnv`.

*Layer 3 — Filesystem read blocking*: `PreToolUse` hook blocks the `Read` tool
on paths matching `SENSITIVE_READ_PATHS` (`~/.buildd/config.json`,
`~/.claude/.credentials.json`) and blocks the `Bash` tool on commands matching
`DANGEROUS_CREDENTIAL_READ_PATTERNS` (shell reads of those same files,
`printenv BUILDD_API_KEY`).

**Invariants**:
- `BUILDD_API_KEY` MUST NOT appear in `cleanEnv`. Any code that sets
  `cleanEnv.BUILDD_API_KEY` is a bug.
- `mcpSecrets` values MUST be resolved into MCP server headers before the SDK
  starts and MUST NOT persist in `cleanEnv` afterward.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and standard shell vars (`PATH`, `HOME`,
  etc.) are intentionally in the passthrough list — these are the agent's own
  LLM credentials, not runner coordination secrets.
- Known gap (Codex only): `BUILDD_MCP_BEARER_TOKEN` and `MCP_BEARER_<NAME>` must
  exist in the Codex subprocess env because the Codex CLI reads bearer tokens from
  env for config.toml auth. This is tracked as a follow-up requiring a Codex CLI
  auth model change.

**Acceptance criteria**:
- AC-1: GIVEN a Claude worker WHEN the agent subprocess starts THEN `BUILDD_API_KEY`
  is absent from the subprocess environment.
- AC-2: GIVEN a role whose connector C has a bearer token WHEN the agent starts
  THEN the raw token value is absent from `cleanEnv`; the MCP connection is
  already authenticated via baked headers.
- AC-3: GIVEN an agent that calls the `Read` tool on `~/.buildd/config.json`
  THEN the PreToolUse hook returns a denial before the file is read.
- AC-4: GIVEN an agent that runs `cat ~/.buildd/config.json` via the Bash tool
  THEN the PreToolUse hook blocks the command.
- AC-5: GIVEN a worker with `ANTHROPIC_API_KEY` set on the runner process WHEN
  the agent subprocess starts THEN `ANTHROPIC_API_KEY` IS present in the
  subprocess environment (LLM credentials are not stripped).
- AC-6 (Codex known gap): GIVEN a Codex worker WHEN the subprocess starts
  THEN `BUILDD_MCP_BEARER_TOKEN` is present in the Codex subprocess env
  (acknowledged exception, tracked separately).

**Code surface**:
- Constants: `packages/shared/src/types.ts` — `SENSITIVE_READ_PATHS` (line 1014),
  `DANGEROUS_CREDENTIAL_READ_PATTERNS` (line 1022).
- Hook: `apps/runner/src/hook-factory.ts` — `PreToolUse` handler for `Read`
  (path allowlist) and `Bash` (pattern denylist).
- Env scoping: `apps/runner/src/workers.ts` — `cleanEnv` allowlist construction,
  `headerExpansionEnv` split, removal of explicit `BUILDD_API_KEY` re-injection.
- Tests: `apps/runner/__tests__/unit/permissions.test.ts` (20 new tests for
  constants), `apps/runner/__tests__/unit/capability-scope.test.ts` (15 new
  tests for allowlist logic).

**Out of scope**: network-layer egress policies (not yet implemented); Codex
bearer-token env isolation (requires Codex CLI change); filesystem jailing at the
OS level (tracked as Tier 4 hardening).

---

## 4. Redaction layers (sensitive workspaces)

**Capability statement**: For workspaces with `dataClass='sensitive'`, the system
MUST apply two independent redaction gates: (A) a PII interceptor on all
outbound BuilddTransport traffic that replaces known PII patterns with
`[REDACTED:type]` tokens, and (B) a content-field denylist on `create_task` that
rejects `outputSchema` definitions containing fields characteristic of raw email
content.

**Invariants**:
- Redaction is active only when `workspace.gitConfig.dataClass === 'sensitive'`.
  Standard workspaces MUST NOT be affected.
- Redaction is *best-effort*: it replaces matches in free-text fields — it does
  NOT block tasks or drop messages. Task continuity takes priority over
  completeness.
- The PII interceptor fires on free-text body fields only: `message`, `summary`,
  `content`, `prompt`, `excerpt`, `label`, `body`, `title` (on note/artifact
  routes). Structural fields (IDs, counts, timestamps) are not redacted.
- The allowlist is applied before pattern matching: UUIDs are masked and
  restored (preventing false positives on UUID hex runs), strings ≥7 pure-hex
  chars are skipped (git SHAs), PR/issue references (`#NNNN`) are excluded
  from the `order_ref` pattern.
- The `outputSchema` denylist checks top-level `string`-typed properties whose
  names appear in `OUTPUT_SCHEMA_CONTENT_DENYLIST`
  (`{subject, body, snippet, sender, from, to, email, address}`). Pointer fields
  (`messageId`, `threadId`, `correlationKey`, `objectId`) are permitted.

**PII patterns (6 active)**:
- `email`: standard email address pattern → `[REDACTED:email]`
- `tracking_ups`: UPS tracking number → `[REDACTED:tracking]`
- `tracking_fedex`: FedEx tracking number → `[REDACTED:tracking]`
- `phone`: NANP phone numbers → `[REDACTED:phone]`
- `address`: US street address pattern → `[REDACTED:address]`
- `order_ref`: short numeric order reference → `[REDACTED:order_ref]` (with
  allowlist exclusions above)

**Known gaps** (documented in module): Anthropic API traffic (not intercepted);
Cue tool results rendered in agent context (intercepted only on the outbound
Buildd transport, not the Cue MCP channel); local disk logs; git commit content;
non-US phone formats.

**Acceptance criteria**:
- AC-1: GIVEN a sensitive workspace WHEN the BuilddTransport sends a message
  containing an email address THEN the outbound payload contains
  `[REDACTED:email]` in place of the address.
- AC-2: GIVEN a standard workspace (no `dataClass='sensitive'`) WHEN the
  BuilddTransport sends a message THEN no redaction is applied and the payload
  is unchanged.
- AC-3: GIVEN a UUID string `550e8400-e29b-41d4-a716-446655440000` in a message
  body WHEN redaction runs THEN the UUID is NOT replaced (allowlisted shape).
- AC-4: GIVEN a `create_task` call for a sensitive workspace with
  `outputSchema` containing a top-level `subject: { type: 'string' }` field
  THEN the API rejects with `400` and error text naming `subject` as a
  content-bearing violation.
- AC-5: GIVEN a `create_task` call for a sensitive workspace with
  `outputSchema` containing `messageId: { type: 'string' }` (pointer field)
  THEN the call succeeds (not in denylist).
- AC-6 (failure case): GIVEN a UPS tracking number in a free-text `summary`
  field WHEN the interceptor fires THEN the tracking number is replaced with
  `[REDACTED:tracking]` before the payload reaches the control plane.
- AC-7: GIVEN a workspace with `dataClass='sensitive'` that transitions to
  standard THEN newly submitted traffic is not redacted (session-level flag
  `activateRedaction()` tracks active sensitive sessions by count).

**Code surface**:
- PII patterns + interceptor: `packages/core/redaction.ts` — `PII_PATTERNS`,
  `activateRedaction()`, `deactivateRedaction()`, `applyRedaction(text)`,
  `redactIncoming(payload)`.
- Transport integration: `packages/core/buildd-transport.ts` + `apps/runner/src/buildd.ts`
  (wires `activateRedaction`/`deactivateRedaction` around sensitive worker sessions).
- outputSchema gate: `apps/web/src/app/api/tasks/route.ts` —
  `OUTPUT_SCHEMA_CONTENT_DENYLIST` (line 22),
  `detectContentBearingSchemaFields()` (line 31), guard at line 366.
- Tests: `packages/core/__tests__/redaction.test.ts` (31 tests).

**Out of scope**: Anthropic API traffic redaction; Cue MCP response redaction;
non-US phone patterns; git-commit content scanning.
