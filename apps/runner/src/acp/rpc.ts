/**
 * ACP's transport: newline-delimited JSON-RPC 2.0 over stdio. stdout carries
 * protocol frames only, so nothing else may write to it (main.ts sends
 * console.log to stderr).
 */
import { RpcError } from './bridge';

export interface RpcHandler {
  handle(method: string, params: unknown): Promise<unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/** Returns a function that takes one input line. Requests run concurrently (a prompt stays open while a cancel arrives). */
export function rpcLineHandler(handler: RpcHandler, write: (frame: string) => void): (line: string) => Promise<void> {
  const send = (msg: Record<string, unknown>) => write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  return async (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    const hasId = msg && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    if (!msg || typeof msg.method !== 'string') {
      // A response to a request we never make, or garbage: answer only what carries an id.
      if (hasId && !('result' in msg) && !('error' in msg)) send({ id: msg.id, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
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
}

export function notification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}
