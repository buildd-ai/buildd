/**
 * What a handler needs from `KernelPorts`, and the one failure when the host
 * did not supply it: a handler whose port is missing throws, so the effect
 * backs off and goes dead loudly instead of being acked as done.
 */
import type { KernelPorts } from '../ports';
import type { DeliverySnapshot } from '../types';

export function need<K extends keyof KernelPorts>(ports: KernelPorts, port: K, kind: string): NonNullable<KernelPorts[K]> {
  const p = ports[port];
  if (!p) throw new Error(`${kind}: the host supplies no ${String(port)} port`);
  return p as NonNullable<KernelPorts[K]>;
}

export type WithPr = DeliverySnapshot & { repoFullName: string; prNumber: number };

export const hasPr = (d: DeliverySnapshot | null | undefined): d is WithPr => !!d?.repoFullName && d.prNumber != null;
