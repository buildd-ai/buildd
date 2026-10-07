/**
 * Which adapter exercises which capability kind. Shared by the generator
 * (`../candidates`, which must never bind a capability nothing can run), the
 * selector (`../selector`, which treats two probes on one execution as one)
 * and the planner (`../executors`).
 */

import type { ScoutCapabilityKind } from '../../scout-capabilities';

export const SCOUT_ADAPTERS = ['command', 'api', 'surface', 'spec', 'readiness'] as const;
export type ScoutAdapterKind = (typeof SCOUT_ADAPTERS)[number];

/** Capability kind → the adapter that exercises it. Unlisted kinds have no adapter yet. */
export const SCOUT_ADAPTER_BY_KIND: Readonly<Partial<Record<ScoutCapabilityKind, ScoutAdapterKind>>> = {
  'verification-command': 'command',
  'typecheck-command': 'command',
  'build-command': 'command',
  'cli-journey': 'command',
  'api-journey': 'api',
  'ui-surface': 'surface',
  spec: 'spec',
  release: 'readiness',
};

/**
 * Adapters whose action is fixed by the capability alone (a command, a
 * request, a capture of declared routes): two probes on one such capability
 * run the same thing. Spec and readiness probes read their own signals.
 */
const CAPABILITY_KEYED_ADAPTERS: ReadonlySet<ScoutAdapterKind> = new Set(['command', 'api', 'surface']);

/** Does every probe bound to this capability id run the same thing? Ids are the kind, or `<kind>:<name>` for a journey. */
export function scoutCapabilityFixesExecution(capabilityId: string): boolean {
  const adapter = SCOUT_ADAPTER_BY_KIND[capabilityId.split(':')[0] as ScoutCapabilityKind];
  return !!adapter && CAPABILITY_KEYED_ADAPTERS.has(adapter);
}
