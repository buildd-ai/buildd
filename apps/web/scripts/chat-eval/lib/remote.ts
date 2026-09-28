/**
 * Live buildd reads for the eval: the remote MCP server (stateless JSON-RPC
 * over HTTP) and a plain REST ApiFn, both on a buildd key.
 */
import type { ApiFn } from '@buildd/core/mcp-tools';
import { builddKey } from './env';

let rpcId = 0;

export async function callRemoteTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { key, url } = builddKey();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  // Stateless servers answer JSON; streamable ones may answer one SSE event.
  const body = raw.trimStart().startsWith('{') ? raw : raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '';
  let parsed: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  try { parsed = JSON.parse(body); } catch { return { text: `Error: HTTP ${res.status} from buildd MCP`, isError: true }; }
  if (parsed.error) return { text: `Error: ${parsed.error.message ?? 'MCP error'}`, isError: true };
  return {
    text: (parsed.result?.content ?? []).map(c => c.text ?? '').join('\n'),
    isError: parsed.result?.isError === true,
  };
}

/** The REST base for a remote MCP url (https://host/api/mcp → https://host). */
export function httpApi(key: string, mcpUrl: string): ApiFn {
  const base = mcpUrl.replace(/\/api\/mcp\/?$/, '');
  return async (endpoint, options = {}) => {
    const res = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(options.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`API error: ${res.status} - ${await res.text()}`);
    return res.json();
  };
}
