#!/usr/bin/env bun
/**
 * A stdio MCP server the eval's `claude -p` connects to. It advertises one
 * surface's tools exactly as the model would see them (tools file written by
 * the runner), executes READS against live buildd through the remote MCP
 * server with a buildd key, and never executes a write: a write gets the
 * answer chat's approval card would (the user decides, nothing ran), and is
 * logged as a proposal.
 *
 * Every call is appended to CHAT_EVAL_LOG with its size, so the report can
 * say which tools' results cost the most.
 *
 * Env: CHAT_EVAL_SURFACE (chat|mcp), CHAT_EVAL_TOOLS (tools.json),
 *      CHAT_EVAL_LOG (calls.jsonl), CHAT_EVAL_QID (question id).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isWrite, MCP_SERVER_INSTRUCTIONS, type Surface, type ToolDef } from './surfaces';
import { builddKey, estTokens } from './env';
import { callRemoteTool, httpApi } from './remote';
import { buildChatTools } from '../../../src/lib/chat/tools';
import { resolveTaskRef } from '../../../src/lib/chat/targets';

const surface = (process.env.CHAT_EVAL_SURFACE ?? 'chat') as Surface;
const tools: ToolDef[] = JSON.parse(readFileSync(process.env.CHAT_EVAL_TOOLS!, 'utf8'));
const logFile = process.env.CHAT_EVAL_LOG;
const qid = process.env.CHAT_EVAL_QID ?? '';

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/**
 * Chat's real tools, executing over HTTP on the buildd key the way /api/mcp's
 * handlers do: same task-word resolution, same spanning of unscoped list reads
 * across workspaces, same truncation, and the same result object the model
 * reads ({ data, objects, summary }, serialized whole: chat has no
 * toModelOutput). Only memory differs (forwarded to the remote recall).
 */
function chatTools() {
  const { key, url } = builddKey();
  const api = httpApi(key, url);
  const pinned = process.env.CHAT_EVAL_WORKSPACE_ID || null;
  const workspaces: Array<{ id: string; name: string; lastActiveAt?: string | null }> = JSON.parse(process.env.CHAT_EVAL_WORKSPACES ?? '[]');
  return buildChatTools({
    ctx: {
      workspaceId: pinned ?? undefined, authType: 'oauth', surface: 'chat',
      getWorkspaceId: async () => pinned, getLevel: async () => 'admin', appBaseUrl: url.replace(/\/api\/mcp\/?$/, ''),
    },
    makeApi: () => api,
    allowWrites: true,
    canAdmin: true,
    authorizedToolCallIds: new Set(),
    resolveTask: ref => resolveTaskRef(api, ref, { missionId: null, missionTitle: null, workspaceId: pinned }),
    ...(pinned ? {} : { workspaces }),
  });
}
let built: ReturnType<typeof chatTools> | null = null;

async function execute(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean; write: boolean; dataChars?: number }> {
  if (isWrite(surface, name, input)) {
    const text = surface === 'chat'
      ? `[eval] An approval card for this ${name} call is now in front of the user, showing exactly what would change. Nothing has run; the user decides on the card.`
      : '[eval] Not executed: this call would change buildd state, and writes are not run in this eval. Tell the user what you would do instead.';
    return { text, isError: false, write: true };
  }
  if (surface === 'chat') {
    if (name === 'list_watches') return { text: '[eval] Watches belong to a signed-in person; this harness reads with a buildd key and has none. You have no watches running.', isError: false, write: false };
    if (name === 'recall') {
      const out = await callRemoteTool('recall', input);
      return { text: JSON.stringify({ data: out.text, objects: [], summary: out.text.split('\n')[0].slice(0, 120) }), isError: out.isError, write: false };
    }
    built ??= chatTools();
    const t = built[name] as { execute?: (i: unknown, o: unknown) => Promise<{ data: string; summary: string }> } | undefined;
    if (!t?.execute) return { text: `Error: unknown tool ${name}`, isError: true, write: false };
    const result = await t.execute(input, { toolCallId: `eval-${Date.now()}`, messages: [] });
    const failed = typeof result.data === 'string' && result.data.startsWith('Error:');
    // dataChars: the part that is text; the rest is the objects array and summary.
    return { text: JSON.stringify(result), isError: failed, write: false, dataChars: String(result.data ?? '').length };
  }
  const out = await callRemoteTool(name, input);
  return { text: out.text, isError: out.isError, write: false };
}

async function onMessage(msg: { id?: number | string; method: string; params?: Record<string, unknown> }) {
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'buildd-eval', version: '0.0.1' },
      ...(surface === 'mcp' ? { instructions: MCP_SERVER_INSTRUCTIONS } : {}),
    } });
  }
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name);
    const input = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    let r: { text: string; isError: boolean; write: boolean; dataChars?: number };
    try {
      r = await execute(name, input);
    } catch (e) {
      r = { text: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true, write: false };
    }
    if (logFile) {
      appendFileSync(logFile, `${JSON.stringify({
        qid, tool: name, action: name === 'buildd' ? input.action : undefined, input, write: r.write,
        chars: r.text.length, ...(r.dataChars !== undefined ? { dataChars: r.dataChars } : {}), estTokens: estTokens(r.text), isError: r.isError,
        truncated: r.text.includes('…[truncated]'), clarification: r.text.includes('Needs clarification'),
        ms: Date.now() - started, head: r.text.slice(0, 160),
      })}\n`);
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void onMessage(msg).catch(e => {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } });
  });
});
