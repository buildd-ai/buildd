/**
 * The in-memory host for the conformance suite
 * (docs/specs/workflow-kernel-library.md §2): the kernel's command runner
 * (`applyCommandOn`) over the in-memory Store, a controllable clock and
 * deterministic ids. `memoryHost()` is the `ConformanceHost` the shared
 * scenarios (./scenarios) run on here; buildd's Postgres host runs the same
 * list under `bun run test:db`.
 *
 * Effects are recorded by the store and run only when a test drains them.
 */
import { applyCommandOn } from '../command-runner';
import type { Command, EffectKind } from '../commands';
import type { CommandResult, DeliveryRef } from '../ports';
import type { KernelView } from '../types';
import { controllableClock, sequentialIds, type ControllableClock } from '../memory/clock';
import { MemoryStore, type EffectRecord, type TransitionRecord } from '../memory/store';
import { staticPolicy } from '../memory/ports';
import type { ConformanceHost } from './scenarios';

export { controllableClock, sequentialIds, type ControllableClock } from '../memory/clock';
export { MemoryStore, type EffectRecord, type TransitionRecord } from '../memory/store';
export type { Clock, CommandResult, DeliveryRef } from '../ports';

/** A host's kernel in memory: submit commands, read views, transitions and owed effects. */
export class InMemoryKernel {
  readonly clock: ControllableClock;
  readonly newId: () => string;
  readonly store: MemoryStore;

  constructor(opts: { clock?: ControllableClock; newId?: () => string } = {}) {
    this.clock = opts.clock ?? controllableClock();
    this.newId = opts.newId ?? sequentialIds();
    this.store = new MemoryStore(this.clock, this.newId);
  }

  submit(cmd: Command, ref?: DeliveryRef, factId?: string | null): Promise<CommandResult> {
    return applyCommandOn(this.store, cmd, { ref, factId, newId: this.newId });
  }

  view(ref: DeliveryRef): KernelView {
    return this.store.viewSync(ref);
  }

  effects(deliveryId: string, kind?: EffectKind): EffectRecord[] {
    return this.store.effects(deliveryId, kind);
  }

  transitions(deliveryId: string): TransitionRecord[] {
    return this.store.transitions(deliveryId);
  }
}

/** The shared scenarios' host on the in-memory store. */
export function memoryHost(k: InMemoryKernel = new InMemoryKernel()): ConformanceHost & { kernel: InMemoryKernel } {
  let owners = 0;
  // §14: the kill switch per workspace, as the host's policy reads it.
  const switchedOff: Record<string, { kernelEnabled: boolean }> = {};
  return {
    kernel: k,
    store: k.store,
    policy: staticPolicy({}, switchedOff),
    newId: k.newId,
    seedOwner: async () => { owners++; return { workspaceId: `w${owners}`, ownerTaskId: `t${owners}` }; },
    uniqueRepo: () => 'acme/widgets',
    effects: async (deliveryId) => k.store.effects(deliveryId).map((e) => ({
      kind: e.kind, payload: e.payload, status: e.status, outcome: e.outcome, attemptCount: e.attemptCount, lastError: e.lastError,
      dedupeKey: e.dedupeKey, transitionId: e.transitionId,
    })),
    transitions: async (deliveryId) => k.store.transitions(deliveryId).map((t) => ({
      fromVersion: t.fromVersion, toVersion: t.toVersion, command: t.command, toState: t.toState,
    })),
    setKernelEnabled: async (workspaceId, on) => { if (on) delete switchedOff[workspaceId]; else switchedOff[workspaceId] = { kernelEnabled: false }; },
  };
}
