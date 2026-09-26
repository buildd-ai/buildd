'use client';

/**
 * Browser calls for the provider-key screens (team admin and personal), over
 * `/api/inference-keys` (see that route and `@buildd/shared` chat.ts).
 *
 * Responses go through `normalizeProviderKeys` / `toKeyStatus`, which only ever
 * hold `last4`, so the key itself is never kept in UI state after it is sent.
 */
import type { ChatProvider, MaskedProviderKey } from '@buildd/shared';
import { normalizeProviderKeys, toKeyStatus, type ProviderKeyStatus, type ProviderKeysView } from './provider-keys-client';

export type KeyScope = 'user' | 'team';

const BASE = '/api/inference-keys';

export class ProviderKeyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ProviderKeyError> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  const msg = typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status})`;
  return new ProviderKeyError(msg, res.status);
}

export async function listProviderKeys(teamId: string): Promise<ProviderKeysView> {
  const res = await fetch(`${BASE}?teamId=${encodeURIComponent(teamId)}`, { cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res);
  return normalizeProviderKeys(await res.json());
}

/**
 * Store a key. The server checks it with the provider first and refuses a
 * rejected key, so a resolved promise means it was stored.
 */
export async function setProviderKey(teamId: string, provider: ChatProvider, scope: KeyScope, value: string): Promise<ProviderKeyStatus | null> {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, provider, scope, value }),
  });
  if (!res.ok) throw await errorFrom(res);
  const body = await res.json().catch(() => ({})) as { key?: MaskedProviderKey };
  return toKeyStatus(body.key ?? null);
}

export async function removeProviderKey(teamId: string, provider: ChatProvider, scope: KeyScope): Promise<void> {
  const qs = new URLSearchParams({ teamId, provider, scope });
  const res = await fetch(`${BASE}?${qs}`, { method: 'DELETE' });
  if (!res.ok) throw await errorFrom(res);
}

export interface KeyTestResult {
  ok: boolean;
  error: string | null;
}

/** Re-check a stored key against a free provider endpoint. */
export async function testProviderKey(teamId: string, provider: ChatProvider, scope: KeyScope): Promise<KeyTestResult> {
  const res = await fetch(`${BASE}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, provider, scope }),
  });
  if (!res.ok) return { ok: false, error: (await errorFrom(res)).message };
  const body = await res.json().catch(() => ({})) as { key?: MaskedProviderKey };
  const status = toKeyStatus(body.key ?? null);
  if (status?.health === 'ok') return { ok: true, error: null };
  if (status?.health === 'degraded') return { ok: false, error: status.error ?? 'The provider answered, but not cleanly. Try again later.' };
  return { ok: false, error: status?.error ?? 'The provider rejected this key.' };
}
