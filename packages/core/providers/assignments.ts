/**
 * Which connected provider serves each surface: `teams.provider_assignments`.
 *
 * Pure, client-safe. With one provider connected nothing is stored and it
 * serves every surface it can. With two or more, a team admin may pick one per
 * surface on Settings › Models. A pick only orders: the resolver tries that
 * provider first within a scope, so a person's own key still goes before the
 * team's, and a provider the surface cannot use is never stored.
 */
import { PROVIDER_IDS, SURFACES, isProviderId, providerDescriptor, type ProviderId, type Surface } from './registry';

export type ProviderAssignments = Partial<Record<Surface, ProviderId>>;

/** A stored or submitted value, keeping only possible surface → provider pairs. */
export function parseProviderAssignments(raw: unknown): ProviderAssignments {
  const out: ProviderAssignments = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const surface of SURFACES) {
    const v = (raw as Record<string, unknown>)[surface];
    if (isProviderId(v) && providerDescriptor(v).surfaces[surface].ok) out[surface] = v;
  }
  return out;
}

/** Why a submitted pair is refused, or null when it may be stored. */
export function assignmentError(surface: unknown, provider: unknown): string | null {
  if (!(SURFACES as readonly unknown[]).includes(surface)) return `surface must be one of ${SURFACES.join(', ')}`;
  if (provider === null) return null;
  if (!isProviderId(provider)) return `provider must be one of ${PROVIDER_IDS.join(', ')}, or null`;
  const support = providerDescriptor(provider).surfaces[surface as Surface];
  return support.ok ? null : support.reason;
}

/** The resolver's provider order for a surface: the assigned one, then registry order. Undefined = no pick. */
export function assignedPreference(assignments: ProviderAssignments, surface: Surface): ProviderId[] | undefined {
  const assigned = assignments[surface];
  return assigned ? [assigned, ...PROVIDER_IDS.filter(p => p !== assigned)] : undefined;
}
