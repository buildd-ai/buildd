/**
 * ACP's transport: newline-delimited JSON-RPC 2.0 over stdio, both ways. The
 * client calls the agent (initialize, session/*); the agent calls the client
 * too (elicitation/create). stdout carries protocol frames only, so nothing
 * else may write to it (main.ts sends console.log to stderr).
 */
import { RpcError } from './bridge';

export interface RpcHandler {
  handle(method: string, params: unknown): Promise<unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

export interface RpcPeer {
  /** Feed one input line. Requests run concurrently (a prompt stays open while a cancel arrives). */
  onLine(line: string): Promise<void>;
  /** Call the client; resolves with its result, rejects with its error. */
  request(method: string, params: unknown): Promise<any>;
}

export function rpcPeer(handler: RpcHandler, write: (frame: string) => void): RpcPeer {
  const send = (msg: Record<string, unknown>) => write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const onLine = async (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    const hasId = !!msg && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    if (!msg || typeof msg.method !== 'string') {
      // A response: settle the request it answers. Ids we never sent are dropped.
      if (hasId && ('result' in msg || 'error' in msg)) {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if ('error' in msg && msg.error) {
          const err = new RpcError(typeof msg.error.code === 'number' ? msg.error.code : INTERNAL_ERROR, String(msg.error.message ?? 'client error'), msg.error.data);
          waiter.reject(err);
        } else {
          waiter.resolve(msg.result);
        }
        return;
      }
      if (hasId) send({ id: msg.id, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }
    try {
      const result = await handler.handle(msg.method, msg.params);
      if (hasId) send({ id: msg.id, result: result ?? null });
    } catch (err) {
      if (!hasId) return;
      const e = err as Partial<RpcError> & Error;
      const code = typeof e.code === 'number' ? e.code : INTERNAL_ERROR;
      send({ id: msg.id, error: { code, message: e.message ?? String(err), ...(e.data === undefined ? {} : { data: e.data }) } });
    }
  };

  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      // Our own id space, prefixed so a reader of the wire can tell the directions apart.
      const id = `buildd-${nextId++}`;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  return { onLine, request };
}

/** Request handling only, for callers that never call the client. */
export function rpcLineHandler(handler: RpcHandler, write: (frame: string) => void): (line: string) => Promise<void> {
  return rpcPeer(handler, write).onLine;
}

export function notification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}
