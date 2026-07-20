/**
 * OAuth-protected Streamable HTTP MCP server.
 *
 * URL: /api/mcp-oauth/<workspaceId>
 *
 * Differences from the API-key-based /api/mcp:
 *  - Bearer is an OAuth 2.1 JWT (issued via /api/oauth/authorize+token), not a `bld_*` key.
 *  - Workspace is bound by the URL path, not a query string. The JWT's
 *    `workspace_id` claim is validated against the path — mismatched tokens
 *    are rejected (so a token for workspace A can't be replayed against B).
 *  - The user's level is forced to admin (via authenticateApiKey's JWT path).
 *  - Internal HTTP self-calls forward the same JWT bearer; the api-auth helper
 *    accepts it transparently.
 *
 * Returns RFC 9728-compliant `WWW-Authenticate` with a resource_metadata hint
 * on 401 so claude.ai can autodiscover the authorization server.
 */
export const maxDuration = 120;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  handleBuilddAction,
  handleMemoryAction,
  allActions as allActionsList,
  memoryActions,
  buildToolDescription,
  buildParamsDescription,
  buildMemoryDescription,
  type ApiFn,
  type ActionContext,
} from '@buildd/core/mcp-tools';
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from '@buildd/core/knowledge-store';
import { verifyAccessToken } from '@/lib/oauth/tokens';
import { getIssuer } from '@/lib/oauth/config';
import { getMemoryClientForTeam } from '@/lib/memory-helper';

function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function unauthorized(workspace: string) {
  // RFC 9728: point claude.ai at the workspace-scoped resource metadata so it
  // can autodiscover the authorization server without static configuration.
  const resourceMetadata = `${getIssuer()}/.well-known/oauth-protected-resource/api/mcp-oauth/${workspace}`;
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="buildd", resource_metadata="${resourceMetadata}"`,
    },
  });
}

function createApi(jwt: string): ApiFn {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXTAUTH_URL || 'https://buildd.dev';

  return async (endpoint, options = {}) => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
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

function createMcpServer(api: ApiFn, workspaceId: string, accountTeamId: string, isSensitive?: boolean) {
  const actions = [...allActionsList];

  const embedder = getVoyageEmbedder();
  const ctx: ActionContext = {
    workspaceId,
    teamId: accountTeamId,
    getWorkspaceId: async () => workspaceId,
    getLevel: async () => 'admin',
    knowledgeStore: new PgVectorStore(embedder, getVoyageReranker()),
    embedder,
  };

  const server = new Server(
    { name: 'buildd', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `Buildd MCP (OAuth) — scoped to workspace ${workspaceId}.

Tools:
- \`buildd\`: task coordination + scheduling. Available actions: ${actions.join(', ')}
- \`recall\` (read knowledge) / \`learn\` (write knowledge) — preferred over buildd_memory.
- \`buildd_memory\`: DEPRECATED. Kept for compatibility; use recall/learn instead.

Workspace is bound to this connector — pass workspaceId only when overriding (rare).`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: object[] = [
      {
        name: 'buildd',
        description: buildToolDescription(actions),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string' as const,
              description: `Action to perform: ${actions.join(', ')}`,
              enum: actions,
            },
            params: {
              type: 'object' as const,
              description: buildParamsDescription(actions),
            },
          },
          required: ['action'],
        },
      },
    ];

    if (!isSensitive) {
      tools.push({
        name: 'buildd_memory',
        description: `DEPRECATED — use recall (read) and learn (write) instead. Kept for compatibility. Actions: ${[...memoryActions].join(', ')}`,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string' as const,
              description: `Action: ${[...memoryActions].join(', ')}`,
              enum: [...memoryActions],
            },
            params: {
              type: 'object' as const,
              description: buildMemoryDescription(memoryActions),
            },
          },
          required: ['action'],
        },
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'buildd') {
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        if (action === 'register_skill' && (params.filePath || params.repo)) {
          return {
            content: [{ type: 'text' as const, text: 'Error: filePath and repo params are not supported in the remote MCP server (no filesystem access). Use the content param instead.' }],
            isError: true,
          };
        }

        // Admin-only knowledge management ops (moved from buildd_memory)
        if (action === 'consolidate_knowledge' || action === 'memory_delete') {
          const memClient = await getMemoryClientForTeam(workspaceId, accountTeamId);
          if (!memClient && action === 'memory_delete') {
            return { content: [{ type: 'text' as const, text: 'Memory service not configured on this server.' }], isError: true };
          }
          const embedder = getVoyageEmbedder();
          const knowledgeStore = new PgVectorStore(embedder, getVoyageReranker());
          return await handleMemoryAction(memClient, action === 'memory_delete' ? 'delete' : 'consolidate_knowledge', params, {
            workspaceId,
            teamId: accountTeamId,
            knowledgeStore,
            embedder,
          });
        }

        return await handleBuilddAction(api, action, params, ctx);
      }
      if (name === 'buildd_memory') {
        // Defense-in-depth: gate even if tool was called despite being absent from
        // ListTools response for sensitive workspaces.
        if (isSensitive) {
          return { content: [{ type: 'text' as const, text: 'Error: buildd_memory is not available in sensitive workspaces.' }], isError: true };
        }
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        const memClient = await getMemoryClientForTeam(workspaceId, accountTeamId);
        if (!memClient) {
          return { content: [{ type: 'text' as const, text: 'Memory service not configured on this server.' }], isError: true };
        }
        return await handleMemoryAction(memClient, action, params, { ...ctx, isSensitive });
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function handle(req: Request, workspace: string): Promise<Response> {
  const jwt = extractBearer(req);
  if (!jwt) return unauthorized(workspace);

  const claims = await verifyAccessToken(jwt, workspace);
  if (!claims) return unauthorized(workspace);

  // Verify workspace exists and grab its team for memory routing.
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspace),
    columns: { id: true, teamId: true, dataClass: true },
  });
  if (!ws) return new Response('Workspace not found', { status: 404 });

  const api = createApi(jwt);
  const isSensitive = (ws.dataClass as string) === 'sensitive';
  const server = createMcpServer(api, workspace, ws.teamId, isSensitive);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

export async function GET() {
  // Stateless: no SSE. 405 prevents claude.ai from polling forever.
  return new Response('SSE not supported on stateless server', { status: 405 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace } = await params;
  return handle(req, workspace);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace } = await params;
  return handle(req, workspace);
}
