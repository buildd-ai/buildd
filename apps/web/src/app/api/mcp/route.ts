/**
 * Streamable HTTP MCP Server — remote, stateless, serverless-compatible.
 *
 * Handles JSON-RPC over HTTP using the MCP Streamable HTTP transport.
 * Auth: Bearer token (API key) validated via the same authenticateApiKey()
 * used by all other API routes.
 *
 * Key decisions:
 * - Stateless (no sessions) — compatible with Vercel serverless
 * - JSON responses (enableJsonResponse: true) — no SSE streaming timeout issues
 * - Server + transport created per request — standard serverless pattern
 * - Internal API calls use caller's Bearer token — no privilege escalation
 * - register_skill with filePath/repo: not supported (no filesystem access)
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hasTokenScope, requiredScopeForAction, tokenWorkspaceAllowed } from "@buildd/core/token-scopes";
import { resolveLinkedDocsWorkspaces } from "@/lib/linked-knowledge";
import { verifyAccountWorkspaceAccess } from "@/lib/team-access";
import { authenticateTaskScopedCaller, isOrchestrationTaskToken } from "@/lib/task-token-auth";
import { scheduleInteractiveTouch } from "@/lib/interactive-worker-liveness";
import { INTERACTIVE_SESSION_HEADER, MCP_SESSION_ID_HEADER, mintMcpSessionId, signInteractiveSession, verifyMcpSessionId } from "@/lib/interactive-session";
import { callerReachesSensitiveWorkspace, isWorkerInCallerScope, isWorkspaceInCallerScope, resolveRepoParamWorkspaceId, workerRunnerSupportsGroupTools } from "@/lib/mcp-request-scope";
import { db } from "@buildd/core/db";
import { workspaces, workers as workersTable, tasks } from "@buildd/core/db/schema";
import { eq } from "drizzle-orm";
import { checkPathClaim, narrowPathClaim } from "@/lib/path-claim-check";
import { gateCallerOrigin } from "@/lib/gate-ledger";
import { enqueueWorkerMessage, type WorkerMessage } from "@buildd/core/worker-messages";
import { WORKER_MSG_MAX_PER_WINDOW, consumeWorkerMsgRateLimit, workerMsgRetryAfterSeconds } from "@/lib/worker-message-rate-limit";
import {
  handleBuilddAction,
  handleMemoryAction,
  handleRecallAction,
  handleLearnAction,
  orchestrationTaskTokenRefusal,
  type ApiFn,
  type ActionContext,
} from "@buildd/core/mcp-tools";
import { afterResponseMemoryLedger } from '@/lib/memory-ledger';
import { memoryDeciderFor } from '@/lib/memory-decisions';
import { listMcpTools, mcpServerInstructions, mcpToolSurfaceFor, routeGroupToolCall, requiredScopeForMcpTool, type McpToolSurface } from "./tools";
import { mcpGroupOfToolName } from "@buildd/core/mcp-tool-groups";
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from "@buildd/core/knowledge-store";
import { getMemoryStoreForTeam as getMemoryClientForTeam } from "@/lib/memory-helper";
import { resolveMemoryProjectKey } from "@buildd/core/memory-scope";
import { builddServerInfo } from "@/lib/mcp-server-info";
import { memberHasRepoAccess, memberRepoAccessMessage } from "@/lib/member-repo-access";

// ── Consumer Skill ───────────────────────────────────────────────────────────
//
// Single canonical source: .claude/skills/buildd-mcp-consumer/SKILL.md (repo
// root, two levels up from apps/web). The `buildd://workspace/skills`
// resource mirrors that file's content directly rather than hand-maintaining
// a second copy — see docs/design/buildd-mcp-consumer-skill.md Q3. Force-added
// despite .claude/ being gitignored (same convention as buildd-workflow), so
// it ships to Vercel like any other tracked file; `outputFileTracingIncludes`
// in next.config.mjs keeps it in the serverless bundle for this route.
const CONSUMER_SKILL_PATH = join(
  process.cwd(),
  "..",
  "..",
  ".claude",
  "skills",
  "buildd-mcp-consumer",
  "SKILL.md"
);

function readConsumerSkillBody(): string {
  try {
    return readFileSync(CONSUMER_SKILL_PATH, "utf8");
  } catch {
    return "buildd-mcp-consumer skill content unavailable on this deployment — see .claude/skills/buildd-mcp-consumer/SKILL.md in the repo for the task lifecycle, blocked-vs-question rule, friction reporting, and branch strategy.";
  }
}

// Same pattern for the one-time onboarding flow: the `buildd://workspace/onboarding`
// resource serves .claude/skills/workspace-onboarding/SKILL.md directly, with
// its own `outputFileTracingIncludes` entry. docs/design/workspace-onboarding.md §5.
const ONBOARDING_SKILL_PATH = join(
  process.cwd(),
  "..",
  "..",
  ".claude",
  "skills",
  "workspace-onboarding",
  "SKILL.md"
);

function readOnboardingSkillBody(): string {
  try {
    return readFileSync(ONBOARDING_SKILL_PATH, "utf8");
  } catch {
    return "workspace-onboarding skill content unavailable on this deployment — see .claude/skills/workspace-onboarding/SKILL.md in the repo for the readiness, scaffold and first-spec flow.";
  }
}

// ── Auth Helper ──────────────────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// ── API Wrapper ──────────────────────────────────────────────────────────────

/**
 * `interactiveMarker` is the server-signed INTERACTIVE_SESSION_HEADER value
 * (lib/interactive-session.ts): it tells the REST routes this call comes from
 * a person's MCP session, which a client-supplied `runner: 'mcp'` cannot.
 */
function createApi(apiKey: string, interactiveMarker?: string | null): ApiFn {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXTAUTH_URL || "https://buildd.dev";

  return async (endpoint, options = {}) => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(interactiveMarker ? { [INTERACTIVE_SESSION_HEADER]: interactiveMarker } : {}),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    return response.json();
  };
}

// ── Memory Helper ────────────────────────────────────────────────────────────

/**
 * Resolve the team that owns a workspace's memories. Memories are team-scoped,
 * so the `memory` KnowledgeStore namespace keys on this id.
 */
async function resolveTeamId(workspaceId: string | null | undefined, fallbackTeamId?: string): Promise<string | null> {
  if (workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (ws?.teamId) return ws.teamId;
  }
  return fallbackTeamId ?? null;
}

/**
 * Canonical `memories.project` key for this connection — always the resolved
 * workspace's own, never the client's `?repo=` hint (that would let a caller
 * name another workspace's memories). Undefined means no memory: no workspace,
 * a sensitive one, or a key it shares with a sensitive workspace.
 */
async function resolveProjectKey(workspaceId: string | null | undefined): Promise<string | undefined> {
  return (await resolveMemoryProjectKey(workspaceId)) ?? undefined;
}

// getMemoryClientForTeam is imported from @/lib/memory-helper (canonical implementation).

/**
 * Resolve workspace dataClass. Returns 'sensitive' on DB failure (fail-closed).
 */
async function resolveWorkspaceDataClass(workspaceId: string | null | undefined): Promise<'standard' | 'sensitive'> {
  if (!workspaceId) return 'standard';
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { dataClass: true },
    });
    return (ws?.dataClass as 'standard' | 'sensitive') ?? 'standard';
  } catch {
    return 'sensitive'; // fail-closed
  }
}

// ── Server Factory ───────────────────────────────────────────────────────────

function createMcpServer(api: ApiFn, accountLevel: 'trigger' | 'worker' | 'admin', workspaceId?: string, repoName?: string, accountTeamId?: string, workerId?: string, authType?: 'api' | 'oauth', appBaseUrl?: string, isSensitive?: boolean, accountId?: string, toolSurface: McpToolSurface = 'groups', tokenScopes?: string[] | null, tokenWorkspaceIds?: string[] | null, orchestrationTaskToken = false, sessionUserId: string | null = null) {
  // Lazy workspace resolver: if URL param didn't resolve, try the account's workspaces
  let resolvedWorkspaceId: string | null = workspaceId || null;
  const getWorkspaceId = async (): Promise<string | null> => {
    if (resolvedWorkspaceId) return resolvedWorkspaceId;

    // Fallback: query account's accessible workspaces via API
    try {
      const data = await api('/api/tasks');
      const taskWorkspaces = (data.tasks || [])
        .map((t: any) => t.workspaceId)
        .filter(Boolean);
      const uniqueIds = Array.from(new Set(taskWorkspaces)) as string[];

      if (uniqueIds.length === 1) {
        resolvedWorkspaceId = uniqueIds[0];
        return resolvedWorkspaceId;
      }

      // If repo hint provided, try matching workspace by repo name from task data
      if (repoName) {
        const wsWithRepo = (data.tasks || []).find((t: any) => t.workspace?.repo === repoName);
        if (wsWithRepo?.workspaceId) {
          resolvedWorkspaceId = wsWithRepo.workspaceId ?? null;
          return resolvedWorkspaceId;
        }
      }
    } catch {
      // API call failed, can't resolve
    }

    return null;
  };

  // KnowledgeStore for best-effort auto-indexing of agent work product
  // (completed tasks, PRs, artifacts, approved plans). The namespace's
  // workspaceId is resolved lazily inside the mirror, so the store can be
  // constructed unconditionally; null embedder falls back to lexical indexing.
  const ctxEmbedder = getVoyageEmbedder();
  const ctxKnowledgeStore = new PgVectorStore(ctxEmbedder, getVoyageReranker());

  /**
   * Whether the knowledge surfaces (memory store, recall/learn, the memory
   * resource) are closed for `wsId`. A pinned workspace's data class is
   * computed once per request (`isSensitive`); a workspace inferred later by
   * getWorkspaceId() gets the same fail-closed lookup here, so an unpinned
   * connection cannot reach a sensitive workspace's knowledge.
   */
  const knowledgeBlockedFor = async (wsId: string | null): Promise<boolean> => {
    if (isSensitive) return true;
    if (!wsId || wsId === workspaceId) return false;
    return (await resolveWorkspaceDataClass(wsId)) === 'sensitive';
  };

  const ctx: ActionContext = {
    // Memory reads record their use after the response, not in a promise
    // the platform may freeze.
    memoryLedger: afterResponseMemoryLedger,
    workerId,
    workspaceId: resolvedWorkspaceId ?? undefined,
    authType,
    getWorkspaceId,
    getLevel: async () => accountLevel,
    getScopes: async () => tokenScopes,
    appBaseUrl,
    knowledgeStore: ctxKnowledgeStore,
    embedder: ctxEmbedder,
    getMemoryClient: async (targetWorkspaceId?: string) => {
      // A named workspace (the task claim_task just claimed) is checked
      // directly, and its store is its own team's — no account-team fallback,
      // which could hand back a different team's store.
      if (targetWorkspaceId) {
        if (await knowledgeBlockedFor(targetWorkspaceId)) return null;
        // A key shared with a sensitive workspace is closed too.
        if (!(await resolveMemoryProjectKey(targetWorkspaceId))) return null;
        return getMemoryClientForTeam(targetWorkspaceId);
      }
      if (await knowledgeBlockedFor(resolvedWorkspaceId)) return null;
      // Without a pinned workspace, the calling action may target a workspace
      // this connection never resolves (claim_task with an explicit id, or a
      // claim across all of the account's workspaces). Fail closed if any
      // workspace the caller reaches is sensitive.
      if (!workspaceId && accountTeamId && accountId
        && await callerReachesSensitiveWorkspace({ id: accountId, teamId: accountTeamId })) {
        return null;
      }
      return getMemoryClientForTeam(resolvedWorkspaceId, accountTeamId);
    },
  };

  /** Shared refusal when the team's memory store cannot be resolved. */
  const memoryStoreUnavailable = () => ({
    content: [{ type: "text" as const, text: "Memory store unavailable — team could not be resolved." }],
    isError: true,
  });

  /**
   * Resolve what every memory / knowledge tool arm needs: the workspace this
   * call belongs to, the team's memory store, and the store/embedder/team
   * context handed to the action handlers.
   *
   * Refuses on OAuth workspace ambiguity. An OAuth token can reach several
   * workspaces, so with none pinned there is no safe default: falling back to
   * the account's team is the misroute class of the claim / create_task bug
   * (2026-05-25 incident), writing knowledge under a team the caller never
   * named. Make the caller pin a workspace instead.
   *
   * Three options stay explicit because the arms genuinely differ, and merging
   * them would change behaviour:
   * - `ambiguousWorkspaceMessage` names the tool family in the refusal.
   * - `memoryStoreRequired`: the admin knowledge-ops arm only needs a store for
   *   a delete; consolidate works off the vector store and tolerates null.
   * - `forwardIsSensitive`: the admin arm must NOT forward it, because
   *   handleMemoryAction refuses `delete` outright for a sensitive workspace and
   *   an admin pruning knowledge has to keep working. recall / learn /
   *   buildd_memory do forward it, as defence in depth behind their own
   *   sensitive-workspace check.
   * - `sensitiveRefusalTool`: when set, refuse if the resolved workspace —
   *   pinned or inferred — is sensitive, naming this tool in the refusal.
   */
  const resolveMemoryContext = async (opts: {
    ambiguousWorkspaceMessage: string;
    memoryStoreRequired: boolean;
    forwardIsSensitive: boolean;
    sensitiveRefusalTool?: string;
  }) => {
    const wsId = await getWorkspaceId();
    if (!wsId && authType === 'oauth') {
      return {
        ok: false as const,
        refusal: {
          content: [{ type: "text" as const, text: opts.ambiguousWorkspaceMessage }],
          isError: true,
        },
      };
    }

    const sensitiveNow = await knowledgeBlockedFor(wsId);
    if (sensitiveNow && opts.sensitiveRefusalTool) {
      return {
        ok: false as const,
        refusal: {
          content: [{ type: "text" as const, text: `Error: ${opts.sensitiveRefusalTool} is not available in sensitive workspaces.` }],
          isError: true,
        },
      };
    }

    const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
    if (!memClient && opts.memoryStoreRequired) {
      return { ok: false as const, refusal: memoryStoreUnavailable() };
    }

    const embedder = getVoyageEmbedder();
    const knowledgeStore = wsId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
    const memTeamId = await resolveTeamId(wsId, accountTeamId);
    // Docs of other same-team workspaces this one links to. Read arms only: the
    // admin knowledge-ops arm never searches.
    const linkedDocsWorkspaceIds = opts.forwardIsSensitive && wsId && accountId && accountTeamId
      ? await resolveLinkedDocsWorkspaces({
          workspaceId: wsId,
          account: { id: accountId, teamId: accountTeamId, workspaceIds: tokenWorkspaceIds },
        })
      : [];

    return {
      ok: true as const,
      memClient,
      memCtx: {
        project: await resolveProjectKey(wsId),
        workerId,
        workspaceId: wsId ?? undefined,
        teamId: memTeamId ?? undefined,
        knowledgeStore,
        embedder,
        api,
        // Jev keep/type/update on writes; fails open to today's rules.
        memoryDecider: memoryDeciderFor(accountId),
        ...(opts.forwardIsSensitive ? { isSensitive: sensitiveNow } : {}),
        ...(linkedDocsWorkspaceIds.length > 0 ? { linkedDocsWorkspaceIds } : {}),
        // The opt-in GitHub repo check, for the person behind an OAuth session
        // only; API keys and runners carry no person (lib/member-repo-access.ts).
        ...(authType === 'oauth' && sessionUserId && wsId
          ? { codeAccessRefusal: async () => {
              const r = await memberHasRepoAccess(sessionUserId, wsId);
              return r.allowed ? null : memberRepoAccessMessage(r);
            } }
          : {}),
      },
    };
  };

  const server = new Server(
    builddServerInfo(appBaseUrl || 'https://buildd.dev'),
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: mcpServerInstructions(accountLevel, toolSurface, tokenScopes),
    }
  );

  // ── Tools ────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMcpTools({ accountLevel, isSensitive: isSensitive === true, surface: toolSurface, scopes: tokenScopes }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    let args = request.params.arguments;

    try {
      // buildd_<group> tools: help and wrong-group errors answer here; an
      // action of the group then runs exactly as it does on `buildd`.
      const group = mcpGroupOfToolName(name);
      if (group) {
        const routed = routeGroupToolCall(group, args as Record<string, unknown> | undefined, accountLevel, tokenScopes);
        if (routed.kind === 'reply') {
          return { content: [{ type: "text" as const, text: routed.text }], ...(routed.isError ? { isError: true } : {}) };
        }
        args = { action: routed.action, params: routed.params };
      }

      if (tokenScopes != null) {
        const p = (args?.params || {}) as Record<string, unknown>;
        const action = args?.action as string;
        const required = requiredScopeForMcpTool(name, args as Record<string, unknown>);
        if (!required || !hasTokenScope(tokenScopes, required)) return { content: [{type:'text' as const,text:JSON.stringify({error:'forbidden',requiredScope:required})}], isError:true };
        if (tokenWorkspaceIds != null) {
          const corpus = name === 'recall' ? args?.scope : p.corpus;
          if ((name === 'recall' || (name === 'buildd_memory' && action === 'query_knowledge')) && (Array.isArray(corpus) ? corpus.includes('initiative') : corpus === 'initiative')) return {content:[{type:'text' as const,text:JSON.stringify({error:'forbidden',reason:'Initiative knowledge is team-wide'})}],isError:true};
          const target = typeof p.workspaceId === 'string' ? p.workspaceId : await getWorkspaceId();
          if (!tokenWorkspaceAllowed(tokenWorkspaceIds, target)) return {content:[{type:'text' as const,text:JSON.stringify({error:'forbidden',reason:'Workspace outside token restriction'})}],isError:true};
        }
      }

      if (name === "buildd" || group) {
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        // An orchestration task's admin-level per-task token reaches only the
        // admin actions its own mission needs; the rest are team-wide. Refused
        // here, before any in-process handler (consolidate_knowledge,
        // memory_delete) or route call.
        if (orchestrationTaskToken) {
          const refusal = orchestrationTaskTokenRefusal(action, params);
          if (refusal) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ error: 'forbidden', reason: refusal, tokenLevel: 'admin', requiredLevel: 'admin' }),
              }],
              isError: true,
            };
          }
        }

        // Block filesystem-dependent actions in remote mode
        if (action === 'register_skill' && (params.filePath || params.repo)) {
          return {
            content: [{ type: "text" as const, text: "Error: filePath and repo params are not supported in the remote MCP server (no filesystem access). Use the content param instead, or use the local stdio MCP server." }],
            isError: true,
          };
        }

        // Admin-only knowledge management ops — moved out of buildd_memory to reduce builder schema cost
        if (action === 'consolidate_knowledge' || action === 'memory_delete') {
          // Guard: these are admin-only; non-admin tokens get a structured 403 (not a bare 401)
          if (tokenScopes == null && accountLevel !== 'admin') {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: 'forbidden',
                  reason: `action '${action}' requires admin token level`,
                  tokenLevel: accountLevel,
                  requiredLevel: 'admin',
                }),
              }],
              isError: true,
            };
          }
          const resolved = await resolveMemoryContext({
            ambiguousWorkspaceMessage: "Cannot resolve workspace. Re-connect with ?workspace=<id> or use the workspace-pinned endpoint.",
            // consolidate_knowledge works straight off the vector store, so a
            // null memory store is only fatal for a delete.
            memoryStoreRequired: action === 'memory_delete',
            // Deliberately not forwarded — see resolveMemoryContext.
            forwardIsSensitive: false,
          });
          if (!resolved.ok) return resolved.refusal;

          return await handleMemoryAction(
            resolved.memClient,
            action === 'memory_delete' ? 'delete' : 'consolidate_knowledge',
            params,
            resolved.memCtx,
          );
        }

        // list_releases / get_release: dispatched through handleBuilddAction, which
        // calls the /api/releases REST routes via `api()` — the same path the
        // OAuth transport (/api/mcp-oauth) and the in-process runner server use.
        // Keeping this as a single shared implementation is what PR #1875 got
        // wrong: an inline DB-backed duplicate here left the OAuth/runner
        // transports with no dispatcher case at all ("Unknown action").
        return await handleBuilddAction(api, action, params, ctx);
      } else if (name === "buildd_memory") {
        // Defense-in-depth: gate even if the tool was somehow called despite being
        // absent from the ListTools response for sensitive workspaces.
        if (isSensitive) {
          return {
            content: [{ type: "text" as const, text: "Error: buildd_memory is not available in sensitive workspaces." }],
            isError: true,
          };
        }
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        const resolved = await resolveMemoryContext({
          ambiguousWorkspaceMessage: "Cannot resolve workspace for memory action. This OAuth token has access to multiple workspaces — re-connect with ?workspace=<id> or use the workspace-pinned /api/mcp-oauth/[workspace]/ endpoint.",
          memoryStoreRequired: true,
          forwardIsSensitive: true,
          sensitiveRefusalTool: "buildd_memory",
        });
        if (!resolved.ok) return resolved.refusal;

        return await handleMemoryAction(resolved.memClient, action, params, resolved.memCtx);
      } else if (name === "recall" || name === "learn") {
        // Defense-in-depth: gate even if the tool was somehow called despite being
        // absent from the ListTools response for sensitive workspaces.
        if (isSensitive) {
          return {
            content: [{ type: "text" as const, text: `Error: ${name} is not available in sensitive workspaces.` }],
            isError: true,
          };
        }
        // Workspace / memory store resolution shared with buildd_memory
        const resolved = await resolveMemoryContext({
          ambiguousWorkspaceMessage: "Cannot resolve workspace for knowledge action. This OAuth token has access to multiple workspaces — re-connect with ?workspace=<id> or use the workspace-pinned /api/mcp-oauth/[workspace]/ endpoint.",
          memoryStoreRequired: true,
          forwardIsSensitive: true,
          sensitiveRefusalTool: name,
        });
        if (!resolved.ok) return resolved.refusal;
        // Non-null by construction: memoryStoreRequired refused above otherwise.
        const memStore = resolved.memClient!;

        if (name === "recall") {
          return await handleRecallAction(memStore, args as Record<string, unknown>, resolved.memCtx);
        } else {
          return await handleLearnAction(memStore, args as Record<string, unknown>, resolved.memCtx);
        }
      } else if (name === "check_path_claim") {
        if (!workerId) {
          return {
            content: [{ type: "text" as const, text: "check_path_claim requires a worker context. Reconnect with ?worker=<workerId> in the MCP URL." }],
            isError: true,
          };
        }

        // Resolve taskId from the worker row; everything after that is the
        // shared implementation (lib/path-claim-check.ts), same as REST.
        const workerRow = await db.query.workers.findFirst({
          where: eq(workersTable.id, workerId),
          columns: { taskId: true },
        });
        if (!workerRow?.taskId) {
          return {
            content: [{ type: "text" as const, text: "No active task found for this worker." }],
            isError: true,
          };
        }

        // release=true is the inverse: give paths back. Same shared
        // implementation as DELETE /api/tasks/[id]/path-claim; the worker
        // context scopes it to this worker's own task.
        if (args?.release === true) {
          const narrowed = await narrowPathClaim({
            taskId: workerRow.taskId,
            paths: args?.paths,
            reason: args?.reason,
            expectedRevision: args?.expectedRevision,
            surface: 'mcp:check_path_claim',
            callerOrigin: gateCallerOrigin({ workerId }),
          });
          switch (narrowed.kind) {
            case 'invalid_paths':
              return { content: [{ type: "text" as const, text: narrowed.error }], isError: true };
            case 'wildcard':
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: narrowed.error }) }], isError: true };
            case 'not_found':
              return { content: [{ type: "text" as const, text: "Task not found." }], isError: true };
            case 'revision_conflict':
              return { content: [{ type: "text" as const, text: JSON.stringify({ released: false, retryable: true, currentRevision: narrowed.currentRevision, error: 'Path claims changed since expectedRevision; re-read and retry' }) }], isError: true };
            case 'narrowed':
              return { content: [{ type: "text" as const, text: JSON.stringify({ released: true, releasedPaths: narrowed.releasedPaths, pathManifest: narrowed.pathManifest, notifiedWaiters: narrowed.notifiedWaiters, revision: narrowed.revision }) }] };
          }
        }

        const outcome = await checkPathClaim({
          taskId: workerRow.taskId,
          paths: args?.paths,
          surface: 'mcp:check_path_claim',
          callerOrigin: gateCallerOrigin({ workerId }),
        });

        switch (outcome.kind) {
          case 'invalid_paths':
          case 'bad_status':
            return { content: [{ type: "text" as const, text: outcome.error }], isError: true };
          case 'wildcard':
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: outcome.error }) }], isError: true };
          case 'not_found':
            return { content: [{ type: "text" as const, text: "Task not found." }], isError: true };
          case 'conflict':
            return { content: [{ type: "text" as const, text: JSON.stringify(outcome.body) }] };
          case 'claimed':
            return { content: [{ type: "text" as const, text: JSON.stringify({ claimed: true, pathManifest: outcome.pathManifest, revision: outcome.revision }) }] };
        }
      } else if (name === "send_worker_message") {
        // Requires worker or admin token — trigger tokens don't run agent work
        if (tokenScopes == null && accountLevel === 'trigger') {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: 'forbidden', reason: 'send_worker_message requires worker or admin token level' }) }],
            isError: true,
          };
        }
        if (!workerId) {
          return {
            content: [{ type: "text" as const, text: "send_worker_message requires a worker context. Reconnect with ?worker=<workerId> in the MCP URL." }],
            isError: true,
          };
        }

        const recipientTaskId = args?.recipientTaskId as string | undefined;
        const msgType = args?.type as string | undefined;
        const msgBody = args?.body as Record<string, unknown> | undefined;
        const incomingHopCount = typeof args?.hopCount === 'number' ? Math.floor(args.hopCount as number) : 0;

        if (!recipientTaskId) {
          return {
            content: [{ type: "text" as const, text: "recipientTaskId is required." }],
            isError: true,
          };
        }

        const VALID_MSG_TYPES = ['path_blocked_on_you', 'path_released', 'question', 'answer'];
        if (!msgType || !VALID_MSG_TYPES.includes(msgType)) {
          return {
            content: [{ type: "text" as const, text: `type must be one of: ${VALID_MSG_TYPES.join(', ')}` }],
            isError: true,
          };
        }

        if (!msgBody || typeof msgBody !== 'object' || Array.isArray(msgBody)) {
          return {
            content: [{ type: "text" as const, text: "body must be a non-null object." }],
            isError: true,
          };
        }

        // Size cap: body JSON must be ≤ 2 KB
        const bodyJson = JSON.stringify(msgBody);
        if (bodyJson.length > 2048) {
          return {
            content: [{ type: "text" as const, text: `body exceeds 2 KB limit (${bodyJson.length} bytes). Reduce message size.` }],
            isError: true,
          };
        }

        // Hop cap: max 5 forwards — prevents ping-pong loops
        if (incomingHopCount >= 5) {
          return {
            content: [{ type: "text" as const, text: `Hop cap reached (hopCount=${incomingHopCount} >= 5). Message dropped to prevent ping-pong loops between workers.` }],
            isError: true,
          };
        }

        // Resolve sender worker → taskId
        const senderWorker = await db.query.workers.findFirst({
          where: eq(workersTable.id, workerId),
          columns: { taskId: true },
        });
        if (!senderWorker?.taskId) {
          return {
            content: [{ type: "text" as const, text: "No active task found for this worker." }],
            isError: true,
          };
        }
        const senderTaskId = senderWorker.taskId;

        // Cannot message your own task
        if (recipientTaskId === senderTaskId) {
          return {
            content: [{ type: "text" as const, text: "Cannot send a message to your own task." }],
            isError: true,
          };
        }

        // Resolve sender task (need workspaceId + context for rate limit)
        const senderTask = await db.query.tasks.findFirst({
          where: eq(tasks.id, senderTaskId),
          columns: { id: true, workspaceId: true, context: true },
        });
        if (!senderTask) {
          return {
            content: [{ type: "text" as const, text: "Sender task not found." }],
            isError: true,
          };
        }

        // Resolve recipient task
        const recipientTask = await db.query.tasks.findFirst({
          where: eq(tasks.id, recipientTaskId),
          columns: { id: true, workspaceId: true, status: true },
        });
        if (!recipientTask) {
          return {
            content: [{ type: "text" as const, text: `Recipient task ${recipientTaskId} not found.` }],
            isError: true,
          };
        }

        // Workspace scope check — data-boundary rule, not optional
        if (recipientTask.workspaceId !== senderTask.workspaceId) {
          return {
            content: [{ type: "text" as const, text: `Cross-workspace messaging is not allowed. Sender and recipient must share a workspaceId.` }],
            isError: true,
          };
        }

        // Terminal recipient: caller can escalate instead of waiting
        const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
        if (TERMINAL_STATUSES.includes(recipientTask.status)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ delivered: false, reason: 'recipient_terminal', recipientStatus: recipientTask.status }),
            }],
          };
        }

        // Rate limit: max 5 messages per sender per minute per recipient task,
        // counted in the sender's task context. Check + increment is one
        // atomic UPDATE — never a whole-context write-back.
        const nowMs = Date.now();
        const allowed = await consumeWorkerMsgRateLimit(senderTaskId, recipientTaskId, nowMs);
        if (!allowed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: 'rate_limited',
                message: `Max ${WORKER_MSG_MAX_PER_WINDOW} messages per minute to this recipient.`,
                retryAfter: workerMsgRetryAfterSeconds(senderTask.context, nowMs),
              }),
            }],
            isError: true,
          };
        }

        const messageId = crypto.randomUUID();
        const workerMessage: WorkerMessage = {
          id: messageId,
          type: msgType as WorkerMessage['type'],
          fromTaskId: senderTaskId,
          fromWorkerId: workerId,
          sentAt: new Date().toISOString(),
          hopCount: incomingHopCount + 1,
          body: msgBody,
        };

        // Deliver via the shared atomic jsonb append (capped), the same path
        // REST and releaseAndNotify use. Served by the recipient's next
        // update_progress check-in and removed only when acked by id.
        const delivered = await enqueueWorkerMessage(recipientTaskId, workerMessage);
        if (!delivered) {
          return {
            content: [{ type: "text" as const, text: `Recipient task ${recipientTaskId} not found.` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ delivered: true, messageId, recipientTaskId }),
          }],
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
        isError: true,
      };
    }
  });

  // ── Resources ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: tokenScopes != null && !hasTokenScope(tokenScopes, "tasks:read") ? [] : [
      {
        uri: "buildd://tasks/pending",
        name: "Pending Tasks",
        description: "Pending tasks sorted by priority",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/memory",
        name: "Workspace Memory",
        description: "Team memories (patterns, gotchas, decisions)",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/skills",
        name: "Workspace Skills",
        description: "Available skills",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/onboarding",
        name: "Workspace Onboarding",
        description: "How to make a repo buildd-ready: readiness, scaffold PR, first spec, first mission",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (tokenScopes != null && !hasTokenScope(tokenScopes, "tasks:read")) throw new Error("forbidden: tasks:read scope required");

    switch (uri) {
      case "buildd://tasks/pending": {
        const data = await api(`/api/tasks${workspaceId ? `?workspaceId=${workspaceId}` : ""}`);
        const pending = (data.tasks || [])
          .filter((t: any) => t.status === "pending")
          .sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));

        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: pending.length === 0
              ? "No pending tasks."
              : pending.map((t: any) =>
                  `[P${t.priority}] ${t.title} (${t.id})\n  ${t.description?.slice(0, 150) || 'No description'}`
                ).join("\n\n"),
          }],
        };
      }

      case "buildd://workspace/memory": {
        try {
          const wsId = await getWorkspaceId();
          if (await knowledgeBlockedFor(wsId)) {
            return {
              contents: [{ uri, mimeType: "text/plain", text: "Workspace memory is not available in sensitive workspaces." }],
            };
          }
          const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
          // No project key means no memory — an unscoped getContext is team-wide.
          const memProject = await resolveProjectKey(wsId);
          if (memClient && memProject) {
            const data = await memClient.getContext(memProject);
            return {
              contents: [{ uri, mimeType: "text/plain", text: data.markdown || "No memories yet." }],
            };
          }
        } catch {
          // Fall through to default message
        }
        return {
          contents: [{ uri, mimeType: "text/plain", text: "No memories found." }],
        };
      }

      case "buildd://workspace/skills":
        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: readConsumerSkillBody(),
          }],
        };

      case "buildd://workspace/onboarding":
        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: readOnboardingSkillBody(),
          }],
        };

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  });

  return server;
}

// ── Request Handler ──────────────────────────────────────────────────────────

async function handleMcpRequest(req: Request): Promise<Response> {
  // Auth
  const apiKey = extractBearerToken(req);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // A per-task token (cloud container) is accepted only as its own worker:
  // `?worker=` is required and checked below.
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve workspace from query params: ?workspace= (ID) or ?repo= (repo name)
  const url = new URL(req.url);
  const workspaceParam = url.searchParams.get("workspace");
  const repoParam = url.searchParams.get("repo");
  let workspaceId: string | undefined;

  if (account.taskScope) {
    // A per-task token acts only in its task's workspace: a different
    // `?workspace=` is refused and `?repo=` is ignored.
    if (workspaceParam && workspaceParam !== account.taskScope.workspaceId) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    workspaceId = account.taskScope.workspaceId;
  } else if (workspaceParam) {
    // Same generic refusal for an unknown workspace and another team's, so the
    // response cannot be used to probe which workspaces exist.
    if (!(await isWorkspaceInCallerScope(workspaceParam, account))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    workspaceId = workspaceParam;
  } else if (repoParam) {
    // Resolved only among the account's own team's workspaces and the ones it
    // is explicitly linked to.
    workspaceId = await resolveRepoParamWorkspaceId(repoParam, account);
    if (!workspaceId) {
      console.warn(`[MCP] No workspace found for repo="${repoParam}"`);
    }
  }

  if (account.workspaceIds != null && (!workspaceId || !tokenWorkspaceAllowed(account.workspaceIds, workspaceId) || !(await verifyAccountWorkspaceAccess(account.id, workspaceId)))) return new Response(JSON.stringify({error:'forbidden'}), {status:403});

  // A `?worker=` id is the worker this session acts as; it must be one the
  // calling account runs, or one in its own team's workspaces.
  const workerParam = url.searchParams.get("worker");
  if (account.taskScope && !workerParam) {
    return new Response(JSON.stringify({ error: "This token requires ?worker=<its own worker id>" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (workerParam && !(await isWorkerInCallerScope(workerParam, account))) {
    return new Response(JSON.stringify({ error: "Worker not found for this account" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The transport is stateless, so this route names the client's session
  // itself: a request that echoes an id we minted for this account is that
  // session; any other gets a fresh id to echo from now on (Streamable HTTP
  // clients must), and is keyless itself, so a client that never echoes keeps
  // the keyless (account-wide) behaviour instead of stranding its claims.
  const incomingSessionId = req.headers.get(MCP_SESSION_ID_HEADER);
  const sessionKey = verifyMcpSessionId(incomingSessionId, account.id);
  const sessionIdToReturn = sessionKey ? incomingSessionId : mintMcpSessionId(account.id);

  // Any MCP request from a worker/admin session is liveness for the
  // interactive workers that session claimed (claim_task, runner = 'mcp');
  // without it the reaper judged them by runner rules and reaped live work
  // (friction 92866723). Runs after the response; best-effort.
  scheduleInteractiveTouch({
    accountId: account.id,
    userId: (account as { sessionUserId?: string }).sessionUserId ?? null,
    sessionKey,
    level: account.level,
  });

  // Create per-request API wrapper, server, and transport
  const api = createApi(apiKey, signInteractiveSession({
    accountId: account.id,
    userId: (account as { sessionUserId?: string }).sessionUserId ?? null,
    sessionKey,
  }));
  const accountLevel = account.level as 'trigger' | 'worker' | 'admin' || 'worker';
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const dataClass = await resolveWorkspaceDataClass(workspaceId);
  const isSensitive = dataClass === 'sensitive';
  // Group tools for every session, except a runner worker whose runner
  // predates them (no CAPABILITY_MCP_GROUP_TOOLS on its heartbeat).
  const toolSurface = mcpToolSurfaceFor({
    workerParam,
    runnerSupportsGroupTools: workerParam ? await workerRunnerSupportsGroupTools(workerParam) : null,
  });
  const server = createMcpServer(api, accountLevel, workspaceId, repoParam || undefined, account.teamId, workerParam || undefined, account.authType, appBaseUrl, isSensitive, account.id, toolSurface, account.scopes, account.workspaceIds, isOrchestrationTaskToken(account), (account as { sessionUserId?: string }).sessionUserId ?? null);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const res = await transport.handleRequest(req);
    if (!sessionIdToReturn) return res;
    const headers = new Headers(res.headers);
    headers.set(MCP_SESSION_ID_HEADER, sessionIdToReturn);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    await transport.close();
    await server.close();
  }
}

// ── Next.js Route Handlers ───────────────────────────────────────────────────

export async function GET(_req: Request): Promise<Response> {
  // Stateless server — no SSE notifications to push.
  // Returning 405 stops MCP clients from polling the SSE endpoint
  // (which otherwise reconnects every ~1s on serverless, burning invocations).
  return new Response("SSE not supported on stateless server", { status: 405 });
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
