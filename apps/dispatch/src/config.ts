// Deployment config shared by the ingest Worker and the ScopeQueue DO.
// Fails closed: a missing BUILDD_SERVER or an empty key ring means no route
// serves and no alarm delivers (the producer keeps its in-app fallback).

import { parseKeyRing } from '@buildd/dispatch-contract';
import { TARGET_TYPES, type TargetType } from './adapters/types';

export interface DispatchConfigEnv {
  /** Producer base URL for callbacks. Set in wrangler.jsonc; no code default. */
  BUILDD_SERVER?: string;
  /** Key ring verifying producer -> Dispatch requests. Secret. */
  PUBLISH_SECRET?: string;
  /** Key ring signing Dispatch -> producer callbacks. Secret. */
  CALLBACK_SECRET?: string;
  /** Comma-separated adapter types run in dry-run. Unset = the shadow default. */
  DRY_RUN_TYPES?: string;
}

/** Producing systems this deployment has a callback base URL and secret for. */
export const KNOWN_SYSTEMS = ['buildd'] as const;

/** Shadow default (P1): webhooks never POST unless explicitly enabled. */
export const DEFAULT_DRY_RUN_TYPES: readonly TargetType[] = ['http'];

export function validServer(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** Names of the settings that are missing or unusable. Empty = configured. */
export function missingConfig(env: DispatchConfigEnv): string[] {
  const missing: string[] = [];
  if (!validServer(env.BUILDD_SERVER)) missing.push('BUILDD_SERVER');
  if (Object.keys(parseKeyRing(env.PUBLISH_SECRET)).length === 0) missing.push('PUBLISH_SECRET');
  if (Object.keys(parseKeyRing(env.CALLBACK_SECRET)).length === 0) missing.push('CALLBACK_SECRET');
  return missing;
}

/** `undefined` (var absent) keeps the safe shadow default; `""` turns dry-run off. */
export function parseDryRunTypes(v: string | undefined): Set<TargetType> {
  if (v === undefined) return new Set(DEFAULT_DRY_RUN_TYPES);
  const known = new Set<string>(TARGET_TYPES);
  return new Set(
    v.split(',').map(s => s.trim()).filter((s): s is TargetType => known.has(s)),
  );
}
