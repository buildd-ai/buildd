/**
 * Recording and scripted adapters for the ports other than the store: a Work
 * and a Notify that record what they were asked, a Policy with fixed knobs,
 * and a Decide that answers from a script (or errors, or never answers).
 */
import type { Decide, DecideAnswer, KernelPolicy, Notify, Policy, Work, WorkRequest } from '../ports';

export class RecordingWork implements Work {
  readonly filed: Array<WorkRequest & { taskId: string }> = [];
  readonly woken: Array<{ taskId: string; reason: string }> = [];
  readonly cancelled: Array<{ taskId: string; reason: string }> = [];
  constructor(private readonly newId: () => string) {}

  async file(req: WorkRequest): Promise<{ taskId: string; created: boolean }> {
    const prior = this.filed.find((f) => f.dedupeKey === req.dedupeKey);
    if (prior) return { taskId: prior.taskId, created: false };
    const taskId = this.newId();
    this.filed.push({ ...structuredClone(req), taskId });
    return { taskId, created: true };
  }
  async wake(taskId: string, reason: string): Promise<void> { this.woken.push({ taskId, reason }); }
  async cancel(taskId: string, reason: string): Promise<void> { this.cancelled.push({ taskId, reason }); }
}

export class RecordingNotify implements Notify {
  readonly activities: Array<{ deliveryId: string; version: number }> = [];
  readonly teams: Array<{ workspaceId: string; deliveryId: string; kind: string; title: string; body?: string }> = [];
  async activity(p: { deliveryId: string; version: number }): Promise<void> { this.activities.push({ ...p }); }
  async team(p: { workspaceId: string; deliveryId: string; kind: string; title: string; body?: string }): Promise<void> { this.teams.push({ ...p }); }
}

export const DEFAULT_KERNEL_POLICY: KernelPolicy = { kernelEnabled: true, landingLane: 'off', maxRounds: 3, maxConflictIterations: 3 };

export function staticPolicy(overrides: Partial<KernelPolicy> = {}, perWorkspace: Record<string, Partial<KernelPolicy>> = {}): Policy {
  return { forWorkspace: async (ws) => ({ ...DEFAULT_KERNEL_POLICY, ...overrides, ...perWorkspace[ws] }) };
}

export type ScriptedAnswer = DecideAnswer | null | { throws: string } | { hangs: true };

/** A decider that answers each point from a script and counts its calls. */
export class ScriptedDecide implements Decide {
  readonly calls: Array<{ point: string; input: Record<string, unknown> }> = [];
  constructor(readonly id: string, private readonly script: Record<string, ScriptedAnswer>) {}

  decide(point: string, input: Record<string, unknown>): Promise<DecideAnswer | null> {
    this.calls.push({ point, input: structuredClone(input) });
    const a = this.script[point];
    if (a === undefined || a === null) return Promise.resolve(null);
    if ('throws' in a) return Promise.reject(new Error(a.throws));
    if ('hangs' in a) return new Promise(() => {});
    return Promise.resolve({ ...a });
  }
}
