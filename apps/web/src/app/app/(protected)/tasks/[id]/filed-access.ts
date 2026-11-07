/**
 * The access a task was filed with, as the task page shows it: each provider
 * it declared or a person granted, and whether its runs get it without asking.
 * Pure; the rules are packages/core/token-delegation.ts.
 */
import { readAccessNeeds, readTaskAccessGrants, type TaskAccessNeed } from '@buildd/core/token-delegation';

export interface FiledAccessEntry {
  provider: string;
  /** "Neon": the slug with a capital, never a connector id. */
  label: string;
  access: 'read';
  reason: string | null;
  /** granted: a person granted it with the task. waiting: declared, nobody granted it yet. */
  status: 'granted' | 'waiting';
  grantedAt: string | null;
}

const NAMES: Record<string, string> = { neon: 'Neon', axiom: 'Axiom', vercel: 'Vercel', github: 'GitHub', linear: 'Linear', sentry: 'Sentry', posthog: 'PostHog' };
export const providerLabel = (slug: string) => NAMES[slug] ?? (slug.charAt(0).toUpperCase() + slug.slice(1));

export function filedAccessEntries(context: unknown, delegation: unknown): FiledAccessEntry[] {
  const grants = readTaskAccessGrants(delegation);
  const needs = readAccessNeeds(context);
  const out: FiledAccessEntry[] = grants.map(g => ({
    provider: g.provider, label: providerLabel(g.provider), access: 'read', reason: g.reason, status: 'granted', grantedAt: g.grantedAt,
  }));
  for (const n of needs) {
    if (out.some(e => e.provider === n.provider)) continue;
    out.push({ provider: n.provider, label: providerLabel(n.provider), access: 'read', reason: n.reason, status: 'waiting', grantedAt: null });
  }
  return out;
}

/** The body that grants every entry (what is granted stays, what waits is added). */
export function grantAllBody(entries: readonly FiledAccessEntry[]): { access: TaskAccessNeed[] } {
  return { access: entries.map(e => ({ provider: e.provider, access: e.access, reason: e.reason })) };
}

/** The body that takes one granted provider back, keeping the other grants. */
export function takeBackBody(entries: readonly FiledAccessEntry[], provider: string): { access: TaskAccessNeed[] } {
  return { access: entries.filter(e => e.status === 'granted' && e.provider !== provider).map(e => ({ provider: e.provider, access: e.access, reason: e.reason })) };
}
