/**
 * Recording and scripted adapters for the ports other than the store: a Work,
 * a Notify, an Ingest and a Lifecycle that record what they were asked, a fake
 * GitHub that answers live reads and merge calls from a script, a Policy with
 * fixed knobs, and a Decide that answers from a script (or errors, or never
 * answers).
 */
import type { LivePr } from '../commands';
import type {
  Decide, DecideAnswer, Escalate, Evidence, ExhaustionNotice, GithubFacts, GithubWrites, Ingest, IngestFact, GithubFactReader, KernelPolicy, Lifecycle,
  MergeAnswer, Notify, Policy, TeamNotice, Trunk, TrunkIncident, Work, WorkFiled, WorkRequest,
  BranchUpdate, Conflicts, HandOff, MechanicalRefresh, MigrationRenumber, PostedReview, ReviewOutput, Reviews,
} from '../ports';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, RoundSnapshot } from '../types';

/** Per role, what the host's builder answers instead of filing (a skip) and what it adds to a filing. */
export type WorkAnswer = Pick<WorkFiled, 'skipped' | 'variant' | 'evidence'>;

export class RecordingWork implements Work {
  readonly filed: Array<WorkRequest & { taskId: string }> = [];
  /** Every request, filed or not. */
  readonly requested: WorkRequest[] = [];
  readonly woken: Array<{ taskId: string; reason: string }> = [];
  readonly cancelled: Array<{ taskId: string; reason: string }> = [];
  readonly cancelledPending: Array<{ deliveryId: string; role: string; reason: string; summary: string; keepTaskId?: string | null }> = [];
  readonly steered: Array<{ taskId: string; marker: string; note: string }> = [];
  /** How many pending tasks `cancelPending` reports; recorded calls are the assertion. */
  pendingToCancel = 0;
  /** `newTaskId`: the id a new task gets (a host whose store references tasks mints a real one). */
  constructor(private readonly newTaskId: (workspaceId: string) => string | Promise<string>, private readonly answers: Record<string, WorkAnswer> = {}) {}

  async file(req: WorkRequest): Promise<WorkFiled> {
    this.requested.push(structuredClone(req));
    const answer = this.answers[req.role] ?? {};
    if (answer.skipped) return { taskId: null, created: false, skipped: answer.skipped };
    const prior = this.filed.find((f) => f.dedupeKey === req.dedupeKey || (req.taskId != null && f.taskId === req.taskId));
    if (prior) return { taskId: prior.taskId, created: false, ...(answer.variant ? { variant: answer.variant } : {}), ...(answer.evidence ? { evidence: structuredClone(answer.evidence) } : {}) };
    const taskId = req.taskId ?? await this.newTaskId(req.workspaceId);
    this.filed.push({ ...structuredClone(req), taskId });
    return { taskId, created: true, ...(answer.variant ? { variant: answer.variant } : {}), ...(answer.evidence ? { evidence: structuredClone(answer.evidence) } : {}) };
  }
  async wake(taskId: string, reason: string): Promise<void> { this.woken.push({ taskId, reason }); }
  async cancel(taskId: string, reason: string): Promise<void> { this.cancelled.push({ taskId, reason }); }
  async cancelPending(p: { deliveryId: string; role: string; reason: string; summary: string; keepTaskId?: string | null }): Promise<number> {
    this.cancelledPending.push({ ...p });
    return this.pendingToCancel;
  }
  async steer(taskId: string, p: { marker: string; note: string }): Promise<void> {
    if (this.steered.some((x) => x.taskId === taskId && x.marker === p.marker)) return;
    this.steered.push({ taskId, ...p });
  }
}

export class RecordingNotify implements Notify {
  readonly activities: Array<{ deliveryId: string; version: number }> = [];
  readonly teams: TeamNotice[] = [];
  /** Runs inside each render, after it is recorded: a test moves the delivery on mid-render with it. */
  onActivity?: (p: { deliveryId: string; version: number }) => Promise<void>;
  async activity(p: { deliveryId: string; version: number; view?: KernelView }): Promise<{ outcome: string }> {
    this.activities.push({ deliveryId: p.deliveryId, version: p.version });
    await this.onActivity?.({ deliveryId: p.deliveryId, version: p.version });
    return { outcome: 'ok:rendered' };
  }
  async team(p: TeamNotice): Promise<void> { this.teams.push({ ...p }); }
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
  /** What a posted review answers; absent = posted. */
  reviewAnswer: PostedReview = { id: null, posted: true };

  /** `ciGreen` answers, keyed `repo@sha`; absent = unknown (null). */
  readonly green = new Map<string, boolean>();
  /** Branch heads, keyed `repo:ref`. */
  readonly heads = new Map<string, string>();
  /** Check runs, keyed `repo@sha`. */
  readonly runs = new Map<string, { complete: boolean; failing: string[] }>();

  async ciGreen(repoFullName: string, headSha: string): Promise<boolean | null> { return this.green.get(`${repoFullName}@${headSha}`) ?? null; }
  async branchHead(repoFullName: string, ref: string): Promise<string | null> { return this.heads.get(`${repoFullName}:${ref}`) ?? null; }
  async checkRuns(repoFullName: string, sha: string): Promise<{ complete: boolean; failing: string[] } | null> {
    const r = this.runs.get(`${repoFullName}@${sha}`);
    return r ? structuredClone(r) : null;
  }

  setPr(repoFullName: string, prNumber: number, live: LivePr | null): void {
    if (live) this.prs.set(`${repoFullName}#${prNumber}`, live); else this.prs.delete(`${repoFullName}#${prNumber}`);
  }
  async readPr(repoFullName: string, prNumber: number): Promise<LivePr | null> {
    const pr = this.prs.get(`${repoFullName}#${prNumber}`);
    return pr ? structuredClone(pr) : null;
  }

  readonly writes: GithubWrites = {
    mergeAtHead: async (p) => { this.merges.push({ ...p }); return { ...this.mergeAnswer }; },
    postReview: async (p) => { this.written.push({ op: 'postReview', ...p }); return { ...this.reviewAnswer }; },
    publishStatus: async (p) => { this.written.push({ op: 'publishStatus', ...p }); },
    upsertComment: async (p) => { this.written.push({ op: 'upsertComment', ...p }); return { id: null }; },
    deleteBranch: async (p) => { this.written.push({ op: 'deleteBranch', ...p }); },
  };
}

/** The trunk incident ledger as data: incidents by id, anchors by incident, the links made. */
export class RecordingTrunk implements Trunk {
  readonly incidents = new Map<string, TrunkIncident>();
  readonly anchors = new Map<string, { taskId: string; incidentId: string; fixSignature: string | null }>();
  readonly links: Array<{ incidentId: string; taskId: string }> = [];
  add(inc: TrunkIncident): void { this.incidents.set(inc.id, structuredClone(inc)); }
  async incident(id: string): Promise<TrunkIncident | null> {
    const inc = this.incidents.get(id);
    return inc ? structuredClone(inc) : null;
  }
  async fixAnchor(incidentId: string): Promise<{ taskId: string; incidentId: string; fixSignature: string | null } | null> {
    return this.anchors.get(incidentId) ?? null;
  }
  async linkFix(incidentId: string, taskId: string): Promise<void> {
    this.links.push({ incidentId, taskId });
    const inc = this.incidents.get(incidentId);
    if (inc && inc.fixTaskId == null && inc.status !== 'resolved') { inc.fixTaskId = taskId; inc.status = 'fixing'; }
  }
  /** Lower-cased, de-duplicated, sorted: the shape of a host signature, without its normalisation. */
  signatureOf(failing: string[]): string {
    const names = [...new Set(failing.map((n) => n.toLowerCase()).filter(Boolean))].sort();
    return names.length ? `ci:${names.join('|')}` : 'ci_failed';
  }
}

/** Records each hand-off to a person, answering a fixed outcome. */
export class RecordingEscalate implements Escalate {
  readonly calls: Array<ExhaustionNotice & { deliveryId: string }> = [];
  constructor(private readonly answer = 'ok') {}
  async exhausted(d: DeliverySnapshot, n: ExhaustionNotice): Promise<string> {
    this.calls.push({ ...n, deliveryId: d.id });
    return this.answer;
  }
}

/** Records each capture, answering a fixed status and record. */
export class RecordingEvidence implements Evidence {
  readonly captures: Array<{ kind: string; workspaceId: string; deliveryId: string; payload: Record<string, unknown> }> = [];
  constructor(private readonly answer: { status: string; record?: Record<string, unknown> } = { status: 'stored', record: { objectKey: 'evidence/ci.log.gz' } }) {}
  async capture(p: { kind: string; workspaceId: string; deliveryId: string; payload: Record<string, unknown> }): Promise<{ status: string; record?: Record<string, unknown> }> {
    this.captures.push(structuredClone(p));
    return structuredClone(this.answer);
  }
}

/** The review loop's host half as data: outputs per round id, scripted answers, every call recorded. */
export class RecordingReviews implements Reviews {
  readonly outputs = new Map<string, ReviewOutput>();
  readonly calls: Array<{ op: string; deliveryId: string; arg?: string }> = [];
  /** `attestComposition`'s answer per round id (absent = review in full). */
  readonly attested = new Map<string, string>();
  async output(round: RoundSnapshot): Promise<ReviewOutput> { return structuredClone(this.outputs.get(round.id) ?? {}); }
  async attestComposition(d: DeliverySnapshot, round: RoundSnapshot): Promise<string | null> {
    this.calls.push({ op: 'attestComposition', deliveryId: d.id, arg: round.id });
    return this.attested.get(round.id) ?? null;
  }
  async postFailed(d: DeliverySnapshot, p: { event: 'APPROVE' | 'REQUEST_CHANGES'; reason: string }): Promise<void> {
    this.calls.push({ op: 'postFailed', deliveryId: d.id, arg: `${p.event}:${p.reason}` });
  }
  async supersedeFixOnApproval(d: DeliverySnapshot): Promise<void> { this.calls.push({ op: 'supersedeFixOnApproval', deliveryId: d.id }); }
  async escalated(d: DeliverySnapshot, round: RoundSnapshot | null): Promise<void> { this.calls.push({ op: 'escalated', deliveryId: d.id, arg: round?.id }); }
  ops(): string[] { return this.calls.map((c) => (c.arg ? `${c.op}:${c.arg}` : c.op)); }
}

/** The conflict families' host half: each git operation answers from a script and is recorded. */
export class RecordingConflicts implements Conflicts {
  readonly calls: Array<{ op: string; deliveryId: string; arg?: string }> = [];
  botOwnedAnswer = false;
  updateAnswer: BranchUpdate = { kind: 'updated' };
  refreshAnswer: MechanicalRefresh = { kind: 'updated' };
  renumberAnswer: MigrationRenumber = { kind: 'renumbered', to: '0010_x.sql' };
  owedAnswer: { owed: boolean; reason?: string } = { owed: true };
  async botOwned(d: DeliverySnapshot): Promise<boolean> { this.calls.push({ op: 'botOwned', deliveryId: d.id }); return this.botOwnedAnswer; }
  async updateBranch(d: DeliverySnapshot, headSha: string): Promise<BranchUpdate> { this.calls.push({ op: 'updateBranch', deliveryId: d.id, arg: headSha }); return { ...this.updateAnswer }; }
  async refresh(d: DeliverySnapshot, attempt: AttemptSnapshot): Promise<MechanicalRefresh> { this.calls.push({ op: 'refresh', deliveryId: d.id, arg: attempt.boundHeadSha ?? '' }); return structuredClone(this.refreshAnswer); }
  async renumber(d: DeliverySnapshot, attempt: AttemptSnapshot): Promise<MigrationRenumber> { this.calls.push({ op: 'renumber', deliveryId: d.id, arg: attempt.boundHeadSha ?? '' }); return structuredClone(this.renumberAnswer); }
  async migrationOwed(d: DeliverySnapshot, _a: AttemptSnapshot, p: { repairKind: string }): Promise<{ owed: boolean; reason?: string }> {
    this.calls.push({ op: 'migrationOwed', deliveryId: d.id, arg: p.repairKind });
    return { ...this.owedAnswer };
  }
  ops(): string[] { return this.calls.map((c) => (c.arg ? `${c.op}:${c.arg}` : c.op)); }
}

/** Legacy's first review as data: the claim once per owner, and what was filed. */
export class RecordingHandOff implements HandOff {
  readonly claimed = new Set<string>();
  readonly reviews: Array<{ deliveryId: string; headSha: string; baseRef: string | null; policyEvidence: unknown }> = [];
  readonly unclaimed: string[] = [];
  firstReviewFails = false;
  async claim(d: DeliverySnapshot): Promise<boolean> {
    if (this.claimed.has(d.ownerTaskId)) return false;
    this.claimed.add(d.ownerTaskId);
    return true;
  }
  async unclaim(d: DeliverySnapshot): Promise<void> { this.claimed.delete(d.ownerTaskId); this.unclaimed.push(d.ownerTaskId); }
  async firstReview(p: { d: DeliverySnapshot; headSha: string; baseRef: string | null; policyEvidence: unknown }): Promise<{ outcome: string }> {
    if (this.firstReviewFails) throw new Error('reviewer creation failed');
    this.reviews.push({ deliveryId: p.d.id, headSha: p.headSha, baseRef: p.baseRef, policyEvidence: p.policyEvidence ?? null });
    return { outcome: p.policyEvidence ? 'human_review_required' : 'review_queued' };
  }
}
