/**
 * Test-only: a process switched over to the control plane (docs/specs/workflow-kernel-library.md
 * §3), for door tests. Sets the web host's own mode and command key, small budgets, and answers
 * every request to the control plane's URL with `reply` (default: the connection refused, so
 * nothing was sent). Other URLs reach the previous fetch. Restore with `restore()`.
 */
import { CONTROL_PLANE_URL, resetKernelModeCache } from '../kernel-client';

export const refusedConnection = (): Error =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

export const refusedByControlPlane = (): Response =>
  Response.json({ v: 1, code: 'forbidden', error: 'user:x does not reach this workspace' }, { status: 403 });

const KEYS = ['EXECUTION_MODE', 'KERNEL_COMMAND_SECRET', 'KERNEL_COMMAND_BUDGET_MS', 'KERNEL_DOOR_BUDGET_MS'] as const;

export function cutOver(o: { reply?: () => Promise<Response> | Response } = {}): { calls: Array<{ op: string | null; body: Record<string, any> | null }>; restore(): void } {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.EXECUTION_MODE = 'own';
  process.env.KERNEL_COMMAND_SECRET = 'k1:cut-over-test';
  process.env.KERNEL_COMMAND_BUDGET_MS = '50';
  process.env.KERNEL_DOOR_BUDGET_MS = '200';
  resetKernelModeCache();
  const calls: Array<{ op: string | null; body: Record<string, any> | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(CONTROL_PLANE_URL)) return original(input, init);
    let body: Record<string, any> | null = null;
    try { body = JSON.parse(String(init?.body ?? '{}')); } catch { /* not JSON */ }
    calls.push({ op: body?.op ?? null, body });
    if (!o.reply) throw refusedConnection();
    return o.reply();
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      resetKernelModeCache();
    },
  };
}
