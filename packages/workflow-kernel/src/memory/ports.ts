/**
 * Recording and scripted adapters for the ports other than the store: a Work,
 * a Notify, an Ingest and a Lifecycle that record what they were asked, a fake
 * GitHub that answers live reads and merge calls from a script, a Policy with
 * fixed knobs, and a Decide that answers from a script (or errors, or never
 * answers).
 */
import type { LivePr } from '../commands';
import type {
  Decide, DecideAnswer, GithubFacts, GithubWrites, Ingest, IngestFact, GithubFactReader, KernelPolicy, Lifecycle, MergeAnswer, Notify, Policy, Work, WorkRequest,
} from '../ports';
import type { DeliverySnapshot, KernelView } from '../types';

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
  /** Runs inside each render, after it is recorded: a test moves the delivery on mid-render with it. */
  onActivity?: (p: { deliveryId: string; version: number }) => Promise<void>;
  async activity(p: { deliveryId: string; version: number; view?: KernelView }): Promise<{ outcome: string }> {
    this.activities.push({ deliveryId: p.deliveryId, version: p.version });
    await this.onActivity?.({ deliveryId: p.deliveryId, version: p.version });
    return { outcome: 'ok:rendered' };
  }
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

/** Records each fact handed to the funnel; `onIngest` lets a test apply what the host's funnel would. */
export class RecordingIngest implements Ingest {
  readonly facts: IngestFact[] = [];
  constructor(private readonly onIngest?: (fact: IngestFact, github: GithubFactReader) => Promise<{ result: string }>) {}
  async ingest(fact: IngestFact, github: GithubFactReader): Promise<{ result: string }> {
    this.facts.push({ ...fact });
    return this.onIngest ? this.onIngest(fact, github) : { result: 'recorded' };
  }
}

/** Records what the host was asked at each lifecycle point, answering from fixed values. */
export class RecordingLifecycle implements Lifecycle {
  readonly calls: Array<{ op: string; deliveryId: string; arg?: string }> = [];
  constructor(private readonly answers: { projected?: number; scan?: string | null; wake?: { woken: boolean; reason?: string } | null; merged?: boolean } = {}) {}
  async projectResolution(d: DeliverySnapshot, resolution: 'superseded' | 'abandoned'): Promise<number> {
    this.calls.push({ op: 'projectResolution', deliveryId: d.id, arg: resolution });
    return this.answers.projected ?? 1;
  }
  async scanSupersession(d: DeliverySnapshot): Promise<string | null> {
    this.calls.push({ op: 'scanSupersession', deliveryId: d.id });
    return this.answers.scan === undefined ? 'none_found' : this.answers.scan;
  }
  async wakeCoordinator(d: DeliverySnapshot, reason: 'pr_resolved'): Promise<{ woken: boolean; reason?: string } | null> {
    this.calls.push({ op: 'wakeCoordinator', deliveryId: d.id, arg: reason });
    return this.answers.wake === undefined ? { woken: true } : this.answers.wake;
  }
  async merged(d: DeliverySnapshot): Promise<boolean> {
    this.calls.push({ op: 'merged', deliveryId: d.id });
    return this.answers.merged ?? true;
  }
  async finalizeMerge(d: DeliverySnapshot): Promise<void> {
    this.calls.push({ op: 'finalizeMerge', deliveryId: d.id });
  }
  ops(): string[] { return this.calls.map((c) => (c.arg ? `${c.op}:${c.arg}` : c.op)); }
}

/**
 * A fake GitHub: live PR reads from `prs` (keyed `repo#n`; absent = unreadable),
 * merge calls answered by `mergeAnswer` and recorded, the other writes recorded.
 */
export class FakeGithub implements GithubFacts {
  readonly prs = new Map<string, LivePr>();
  readonly merges: Array<{ repoFullName: string; prNumber: number; headSha: string; method?: string }> = [];
  readonly written: Array<{ op: string; [k: string]: unknown }> = [];
  mergeAnswer: MergeAnswer = { outcome: 'merged', detail: 'Pull Request successfully merged' };

  setPr(repoFullName: string, prNumber: number, live: LivePr | null): void {
    if (live) this.prs.set(`${repoFullName}#${prNumber}`, live); else this.prs.delete(`${repoFullName}#${prNumber}`);
  }
  async readPr(repoFullName: string, prNumber: number): Promise<LivePr | null> {
    const pr = this.prs.get(`${repoFullName}#${prNumber}`);
    return pr ? structuredClone(pr) : null;
  }

  readonly writes: GithubWrites = {
    mergeAtHead: async (p) => { this.merges.push({ ...p }); return { ...this.mergeAnswer }; },
    postReview: async (p) => { this.written.push({ op: 'postReview', ...p }); return { id: null }; },
    publishStatus: async (p) => { this.written.push({ op: 'publishStatus', ...p }); },
    upsertComment: async (p) => { this.written.push({ op: 'upsertComment', ...p }); return { id: null }; },
    deleteBranch: async (p) => { this.written.push({ op: 'deleteBranch', ...p }); },
  };
}
