/**
 * A stateful, in-memory GitHub for kernel tests (docs/specs/workflow-state-kernel.md
 * §2 R2, §10). It stands in for GitHub where the kernel actually reaches it:
 *
 *  - `fake.fetch` / `fake.installFetch()`: `https://api.github.com/*` as HTTP,
 *    so the real `githubApi`, `mergePullRequest` and `postPrReview` run their
 *    own status and body handling against it. Every other URL passes through
 *    (the local neon-http shim is a fetch too).
 *  - `fake.api`: the `githubApi` signature (throws `GitHub API error: <status> <body>`),
 *    for the handlers and helpers that take an injectable `api`.
 *  - `fake.reader()`: the real `githubReader` over `fake.api`, i.e. a
 *    `GithubFactReader` whose parsing is production code.
 *
 * The model is a real commit graph: commits carry whole trees, merges are
 * three-way per path, so `behind`, `dirty`, update-branch and the compare API
 * (content equivalence, ancestry) fall out of the history instead of being
 * set by hand. Mergeability is computed lazily, as GitHub's is.
 *
 * Webhooks are hints (R2): operations queue them with GitHub's payload shapes,
 * and `deliverWebhooks()` hands them to whatever ingest the test wired up.
 *
 * Faults are switches, each with its own seeded stream so turning one on never
 * changes another's draws: webhook drop / duplicate / reorder / early (handed
 * over while the read model still shows the state before the event),
 * mergeability unknown for N reads, the head moving between the read and the
 * merge, 5xx, rate limits, an answer lost after the write applied, and check
 * runs reported for the previous head.
 *
 * Test-only. Nothing in production imports this file.
 */
import { githubReader } from '../github-facts';
import type { GithubFactReader } from '../facts';

// ── Model ──────────────────────────────────────────────────────────────────

type Tree = Map<string, string>;
/** Path → new content; `null` deletes the path. */
export type Changes = Record<string, string | null>;

interface Commit { sha: string; parents: string[]; tree: Tree; message: string; date: string }

/** waiting / requested / pending are GitHub Actions only: a job held by an environment rule or a concurrency group. */
export type CheckStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
/** A commit status (the Statuses API), latest per context. */
export type CommitStatusState = 'success' | 'failure' | 'error' | 'pending';
export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'startup_failure' | null;

interface CheckRun { id: number; name: string; headSha: string; status: CheckStatus; conclusion: CheckConclusion; suiteId: number; workflow: string; startedAt: string; completedAt: string | null }

interface CommitStatus { context: string; sha: string; state: CommitStatusState; description: string; updatedAt: string }

interface Review { id: number; user: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commitId: string; body: string; submittedAt: string }

interface IssueComment { id: number; issue: number; body: string; user: string; createdAt: string; updatedAt: string }

interface Pr {
  number: number; id: number; title: string; body: string; user: string;
  headRef: string; headSha: string; baseRef: string;
  state: 'open' | 'closed'; merged: boolean; draft: boolean;
  mergedAt: string | null; mergeCommitSha: string | null; mergedBy: string | null; closedAt: string | null;
  createdAt: string; updatedAt: string;
  reviews: Review[];
  /** Heads this PR held before the current one, oldest first. */
  previousHeads: string[];
  /** The (head, base tip) GitHub last computed mergeability for, and how many reads stay unknown. */
  mergeability: { key: string | null; unknownLeft: number };
  /** Read-model lag: while set, REST reads of this PR return this (or 404 for `'missing'`). */
  frozen: Record<string, unknown> | 'missing' | null;
}

export interface Protection {
  /** Require the branch to be up to date before merging (GitHub's "strict"). Off: `behind` is never reported. */
  strict?: boolean;
  requiredChecks?: string[];
  requiredApprovals?: number;
}

interface Repo {
  fullName: string; id: number; owner: string; name: string; defaultBranch: string;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  pulls: Map<number, Pr>;
  checkRuns: CheckRun[];
  statuses: CommitStatus[];
  comments: Map<number, IssueComment>;
  protection: Map<string, Protection>;
}

// ── Faults ─────────────────────────────────────────────────────────────────

/** A probability (0..1), optionally with its own seed. */
export type Fault = number | { rate: number; seed?: number };

export interface Faults {
  webhookDrop?: Fault;
  webhookDuplicate?: Fault;
  webhookReorder?: Fault;
  /** The hint arrives while REST reads of the PR still show the state before the event (404 for a new PR). */
  webhookEarly?: Fault;
  /** After every head or base move, `mergeable` stays null / `unknown` for this many reads. */
  mergeableUnknownReads?: number;
  /** Someone pushes to the head between the caller's read and its pinned merge / update-branch. */
  headMovesBeforeWrite?: Fault;
  /** A 502 with an HTML body, before anything is applied. */
  serverError?: Fault;
  /** A 403 "API rate limit exceeded", before anything is applied. */
  rateLimit?: Fault;
  /** A write is applied but its answer is lost: the caller sees a 502. */
  lostResponse?: Fault;
  /** Check runs / suites / status read for a PR head return the previous head's. */
  staleChecks?: Fault;
  /** Limit the call faults (serverError, rateLimit, lostResponse) to matching `METHOD /path`. */
  callMatch?: RegExp;
}

type FaultName = Exclude<keyof Faults, 'mergeableUnknownReads' | 'callMatch'>;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function hex40(s: string): string {
  let out = '';
  for (let i = 0; out.length < 40; i++) out += hash32(`${i}:${s}`).toString(16).padStart(8, '0');
  return out.slice(0, 40);
}

// ── Webhooks ───────────────────────────────────────────────────────────────

export interface WebhookDelivery {
  /** `X-GitHub-Delivery`: a redelivery keeps it. */
  id: string;
  /** `X-GitHub-Event`. */
  name: 'pull_request' | 'pull_request_review' | 'check_run' | 'check_suite' | 'push' | 'issue_comment';
  payload: Record<string, unknown> & { action?: string; installation: { id: number; node_id?: string } };
}

interface QueuedHook extends WebhookDelivery {
  /** The PR the event is about, and its REST shape before the event (for `webhookEarly`). */
  pr?: { repo: string; number: number; before: Record<string, unknown> | 'missing' };
}

export type WebhookListener = (d: WebhookDelivery) => unknown | Promise<unknown>;

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface FakeResponse { status: number; body: unknown; headers?: Record<string, string> }

class HttpError extends Error {
  constructor(public status: number, message: string, public raw?: string) { super(message); }
}

const notFound = () => new HttpError(404, 'Not Found');

export interface FakeGithubOptions {
  /** Seed for every fault stream that does not carry its own. */
  seed?: number;
  installationId?: number;
  faults?: Faults;
  /** The bot login API writes are attributed to. */
  appLogin?: string;
  /** The fake clock's start; every operation advances it by one second. */
  epoch?: string;
}

export class FakeGithub {
  readonly installationId: number;
  readonly appLogin: string;
  /** Every REST call, in order, with the status answered. */
  readonly calls: Array<{ method: string; path: string; status: number }> = [];
  /** Routes the fake does not model (answered 404). A test can assert this stays empty. */
  readonly unsupported: string[] = [];
  /** Webhooks handed to listeners (a duplicate appears twice), and the ones dropped. */
  readonly delivered: WebhookDelivery[] = [];
  readonly dropped: WebhookDelivery[] = [];

  private repos = new Map<string, Repo>();
  private queue: QueuedHook[] = [];
  private listeners: WebhookListener[] = [];
  private faults: Faults;
  private seed: number;
  private streams = new Map<FaultName, () => number>();
  private oneShots: Array<{ match: RegExp; status: number; message: string }> = [];
  private seq = 0;
  private clock: number;

  constructor(opts: FakeGithubOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.installationId = opts.installationId ?? 1;
    this.appLogin = opts.appLogin ?? 'buildd[bot]';
    this.faults = { ...(opts.faults ?? {}) };
    this.clock = Date.parse(opts.epoch ?? '2026-10-01T00:00:00Z');
  }

  // ── Faults ──────────────────────────────────────────────────────────────

  /** Merge `f` into the active faults (`undefined` / 0 turns one off). Streams restart from their seeds. */
  setFaults(f: Faults): void {
    this.faults = { ...this.faults, ...f };
    this.streams.clear();
  }

  /** The next call matching `match` (against `METHOD /path`) answers `status` with `message`, before anything applies. */
  failNext(match: RegExp, status: number, message = 'injected'): void {
    this.oneShots.push({ match, status, message });
  }

  private fires(name: FaultName): boolean {
    const f = this.faults[name];
    if (f == null) return false;
    const rate = typeof f === 'number' ? f : f.rate;
    if (!(rate > 0)) return false;
    let next = this.streams.get(name);
    if (!next) {
      const seed = typeof f === 'number' || f.seed == null ? this.seed : f.seed;
      next = mulberry32(seed ^ hash32(name));
      this.streams.set(name, next);
    }
    return next() < rate;
  }

  // ── Clock and ids ─────────────────────────────────────────────────────────

  private tick(): string { this.clock += 1000; return new Date(this.clock).toISOString().replace('.000Z', 'Z'); }
  private now(): string { return new Date(this.clock).toISOString().replace('.000Z', 'Z'); }
  private nextId(): number { return ++this.seq; }
  private newSha(kind: string): string { return hex40(`${this.seed}:${kind}:${this.nextId()}`); }
  private guid(): string {
    const h = hex40(`guid:${this.seed}:${this.nextId()}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  // ── Repos, branches, commits ──────────────────────────────────────────────

  createRepo(fullName: string, opts: { defaultBranch?: string; files?: Changes } = {}): string {
    const [owner, name] = fullName.split('/');
    const defaultBranch = opts.defaultBranch ?? 'main';
    const repo: Repo = {
      fullName, id: this.nextId(), owner, name, defaultBranch,
      branches: new Map(), commits: new Map(), pulls: new Map(), checkRuns: [], statuses: [], comments: new Map(), protection: new Map(),
    };
    this.repos.set(fullName, repo);
    const root = this.makeCommit(repo, [], new Map(), opts.files ?? { 'README.md': `# ${name}\n` }, 'initial commit');
    repo.branches.set(defaultBranch, root);
    return root;
  }

  private repo(fullName: string): Repo {
    const r = this.repos.get(fullName);
    if (!r) throw notFound();
    return r;
  }

  private makeCommit(repo: Repo, parents: string[], base: Tree, changes: Changes, message: string): string {
    const tree: Tree = new Map(base);
    for (const [p, c] of Object.entries(changes)) {
      if (c === null) tree.delete(p); else tree.set(p, c);
    }
    const sha = this.newSha('commit');
    repo.commits.set(sha, { sha, parents, tree, message, date: this.tick() });
    return sha;
  }

  private commit(repo: Repo, sha: string): Commit {
    const c = repo.commits.get(sha);
    if (!c) throw new HttpError(404, `No commit found for SHA: ${sha}`);
    return c;
  }

  protect(repoName: string, branch: string, p: Protection): void { this.repo(repoName).protection.set(branch, p); }

  branchHead(repoName: string, branch: string): string | null { return this.repo(repoName).branches.get(branch) ?? null; }

  /** The tree at `ref` (branch or sha), for assertions. */
  files(repoName: string, ref: string): Record<string, string> {
    const repo = this.repo(repoName);
    return Object.fromEntries(this.commit(repo, this.resolve(repo, ref)).tree);
  }

  createBranch(repoName: string, branch: string, from?: string): string {
    const repo = this.repo(repoName);
    const sha = this.resolve(repo, from ?? repo.defaultBranch);
    repo.branches.set(branch, sha);
    this.emitPush(repo, branch, '0'.repeat(40), sha, { created: true, forced: false, pusher: 'dev' });
    return sha;
  }

  deleteBranch(repoName: string, branch: string): void {
    const repo = this.repo(repoName);
    const was = repo.branches.get(branch);
    if (!was) throw new HttpError(422, 'Reference does not exist');
    repo.branches.delete(branch);
    this.emitPush(repo, branch, was, '0'.repeat(40), { deleted: true, forced: false, pusher: 'dev' });
    // GitHub retargets PRs stacked on the head branch of a merged PR to that PR's base
    // (pull_request.edited, changes.base); any other PR whose base is deleted is closed.
    const merged = [...repo.pulls.values()].find((p) => p.merged && p.headRef === branch);
    for (const pr of repo.pulls.values()) {
      if (pr.state !== 'open' || pr.baseRef !== branch) continue;
      if (merged && repo.branches.has(merged.baseRef)) this.retargetInternal(repo, pr, merged.baseRef, 'dev');
      else this.closeInternal(repo, pr, 'dev');
    }
  }

  /** Change a PR's base: the head stays, the diff is recomputed, `edited` carries `changes.base`. */
  private retargetInternal(repo: Repo, pr: Pr, base: string, by: string): void {
    if (pr.baseRef === base) return;
    const snap = this.prJson(repo, pr, false);
    const from = { ref: pr.baseRef, sha: repo.branches.get(pr.baseRef) ?? null };
    pr.baseRef = base;
    pr.updatedAt = this.tick();
    this.emitPr(repo, pr, 'edited', snap, { changes: { base: { ref: { from: from.ref }, sha: { from: from.sha } } } }, by);
  }

  /** A fast-forward push of one commit to `branch` (created from the default branch if missing). */
  push(repoName: string, branch: string, changes: Changes, opts: { message?: string; pusher?: string } = {}): string {
    const repo = this.repo(repoName);
    if (!repo.branches.has(branch)) this.createBranch(repoName, branch);
    const parent = repo.branches.get(branch)!;
    const sha = this.makeCommit(repo, [parent], this.commit(repo, parent).tree, changes, opts.message ?? `update ${branch}`);
    this.moveBranch(repo, branch, sha, { forced: false, pusher: opts.pusher ?? 'dev' });
    return sha;
  }

  /** A history rewrite: one commit on `onto` (default: the base branch tip, i.e. a rebase) carrying the branch's tree plus `changes`. */
  forcePush(repoName: string, branch: string, opts: { onto?: string; changes?: Changes; message?: string; pusher?: string } = {}): string {
    const repo = this.repo(repoName);
    const old = repo.branches.get(branch);
    if (!old) throw notFound();
    const pr = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === branch);
    const onto = this.resolve(repo, opts.onto ?? pr?.baseRef ?? repo.defaultBranch);
    // Replay the branch's own change onto `onto`.
    const mb = this.mergeBase(repo, old, onto);
    const own = mb ? this.diffTrees(this.commit(repo, mb).tree, this.commit(repo, old).tree) : {};
    const sha = this.makeCommit(repo, [onto], this.commit(repo, onto).tree, { ...own, ...(opts.changes ?? {}) }, opts.message ?? `rewrite ${branch}`);
    this.moveBranch(repo, branch, sha, { forced: true, pusher: opts.pusher ?? 'dev' });
    return sha;
  }

  /** The base moved on (someone else's merge): a commit straight onto `branch`. */
  advanceBase(repoName: string, branch: string, changes: Changes, message = `advance ${branch}`): string {
    return this.push(repoName, branch, changes, { message, pusher: 'someone-else' });
  }

  private diffTrees(from: Tree, to: Tree): Changes {
    const out: Changes = {};
    for (const [p, c] of to) if (from.get(p) !== c) out[p] = c;
    for (const p of from.keys()) if (!to.has(p)) out[p] = null;
    return out;
  }

  private resolve(repo: Repo, ref: string): string {
    const r = ref.replace(/^refs\/heads\//, '');
    const b = repo.branches.get(r);
    if (b) return b;
    if (repo.commits.has(r)) return r;
    const prefix = [...repo.commits.keys()].find((s) => r.length >= 7 && s.startsWith(r));
    if (prefix) return prefix;
    throw new HttpError(404, `No commit found for SHA: ${ref}`);
  }

  private ancestors(repo: Repo, sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(repo.commits.get(s)?.parents ?? []));
    }
    return seen;
  }

  isAncestor(repoName: string, ancestor: string, of: string): boolean {
    const repo = this.repo(repoName);
    return this.ancestors(repo, this.resolve(repo, of)).has(this.resolve(repo, ancestor));
  }

  private mergeBase(repo: Repo, a: string, b: string): string | null {
    const A = this.ancestors(repo, a);
    const common = [...this.ancestors(repo, b)].filter((s) => A.has(s));
    // The best common ancestor: one no other common ancestor descends from.
    const best = common.filter((c) => !common.some((o) => o !== c && this.ancestors(repo, o).has(c)));
    return best[0] ?? null;
  }

  /** Three-way merge of `theirs` into `ours`. */
  private threeWay(repo: Repo, ours: string, theirs: string): { tree: Tree; conflicts: string[] } {
    const mb = this.mergeBase(repo, ours, theirs);
    const o = mb ? this.commit(repo, mb).tree : new Map<string, string>();
    const a = this.commit(repo, ours).tree;
    const b = this.commit(repo, theirs).tree;
    const tree: Tree = new Map();
    const conflicts: string[] = [];
    for (const p of new Set([...a.keys(), ...b.keys(), ...o.keys()])) {
      const va = a.get(p); const vb = b.get(p); const vo = o.get(p);
      let v: string | undefined;
      if (va === vb) v = va;
      else if (va === vo) v = vb;
      else if (vb === vo) v = va;
      else { conflicts.push(p); v = va; }
      if (v !== undefined) tree.set(p, v);
    }
    return { tree, conflicts };
  }

  private moveBranch(repo: Repo, branch: string, sha: string, o: { forced: boolean; pusher: string }): void {
    const before = repo.branches.get(branch) ?? '0'.repeat(40);
    repo.branches.set(branch, sha);
    this.emitPush(repo, branch, before, sha, { forced: o.forced, pusher: o.pusher });
    for (const pr of repo.pulls.values()) {
      if (pr.state !== 'open' || pr.headRef !== branch || pr.headSha === sha) continue;
      const snap = this.prJson(repo, pr, false);
      pr.previousHeads.push(pr.headSha);
      pr.headSha = sha;
      pr.updatedAt = this.tick();
      this.emitPr(repo, pr, 'synchronize', snap, { before: pr.previousHeads.at(-1), after: sha }, o.pusher);
    }
  }

  // ── Pull requests ────────────────────────────────────────────────────────

  openPr(repoName: string, o: { head: string; base?: string; title?: string; body?: string; draft?: boolean; user?: string }): number {
    const repo = this.repo(repoName);
    const headSha = repo.branches.get(o.head);
    if (!headSha) throw new HttpError(422, `Validation Failed: head ${o.head} does not exist`);
    const number = this.nextId();
    const at = this.tick();
    const pr: Pr = {
      number, id: 1_000_000 + number, title: o.title ?? `PR from ${o.head}`, body: o.body ?? '', user: o.user ?? 'dev',
      headRef: o.head, headSha, baseRef: o.base ?? repo.defaultBranch, state: 'open', merged: false, draft: !!o.draft,
      mergedAt: null, mergeCommitSha: null, mergedBy: null, closedAt: null, createdAt: at, updatedAt: at,
      reviews: [], previousHeads: [], mergeability: { key: null, unknownLeft: 0 }, frozen: null,
    };
    repo.pulls.set(number, pr);
    this.emitPr(repo, pr, 'opened', 'missing', {}, pr.user);
    return number;
  }

  pr(repoName: string, number: number): Readonly<Pr> {
    const pr = this.repo(repoName).pulls.get(number);
    if (!pr) throw notFound();
    return pr;
  }

  closePr(repoName: string, number: number, by = 'dev'): void {
    const repo = this.repo(repoName);
    const pr = this.pullOf(repo, number);
    if (pr.state === 'closed') return;
    this.closeInternal(repo, pr, by);
  }

  private closeInternal(repo: Repo, pr: Pr, by: string): void {
    const snap = this.prJson(repo, pr, false);
    pr.state = 'closed';
    pr.closedAt = pr.updatedAt = this.tick();
    this.emitPr(repo, pr, 'closed', snap, {}, by);
  }

  reopenPr(repoName: string, number: number, by = 'dev'): void {
    const repo = this.repo(repoName);
    const pr = this.pullOf(repo, number);
    if (pr.state === 'open' || pr.merged) throw new HttpError(422, 'Validation Failed: state cannot be changed.');
    if (!repo.branches.has(pr.baseRef)) throw new HttpError(422, 'Validation Failed: base branch was deleted');
    const snap = this.prJson(repo, pr, false);
    pr.state = 'open';
    pr.closedAt = null;
    // A branch pushed while the PR was closed is the head it reopens at.
    const branchHead = repo.branches.get(pr.headRef);
    if (branchHead && branchHead !== pr.headSha) { pr.previousHeads.push(pr.headSha); pr.headSha = branchHead; }
    pr.updatedAt = this.tick();
    this.emitPr(repo, pr, 'reopened', snap, {}, by);
  }

  /** A person merges in the GitHub UI: same rules as the API, no pinned sha. */
  mergePr(repoName: string, number: number, o: { method?: 'merge' | 'squash' | 'rebase'; by?: string } = {}): string {
    const repo = this.repo(repoName);
    return this.mergeInternal(repo, this.pullOf(repo, number), { method: o.method ?? 'squash', by: o.by ?? 'dev' });
  }

  /** GitHub's update-branch: merge the base into the head, server-side. */
  updateBranch(repoName: string, number: number, o: { expectedHeadSha?: string; by?: string } = {}): string {
    const repo = this.repo(repoName);
    return this.updateBranchInternal(repo, this.pullOf(repo, number), o.expectedHeadSha, o.by ?? 'dev');
  }

  review(repoName: string, number: number, o: { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; user?: string; body?: string; commitId?: string }): number {
    const repo = this.repo(repoName);
    const pr = this.pullOf(repo, number);
    const rv: Review = { id: this.nextId(), user: o.user ?? 'reviewer', state: o.state, commitId: o.commitId ?? pr.headSha, body: o.body ?? '', submittedAt: this.tick() };
    pr.reviews.push(rv);
    this.enqueue(repo, 'pull_request_review', {
      action: 'submitted', review: this.reviewJson(repo, pr, rv, true), pull_request: this.prJson(repo, pr, false, true),
    }, rv.user, { pr, before: this.prJson(repo, pr, false) });
    return rv.id;
  }

  /** Create or update a check run on `sha`; completing the last run of a suite also sends `check_suite.completed`. */
  setCheck(repoName: string, sha: string, name: string, s: { status?: CheckStatus; conclusion?: CheckConclusion; workflow?: string } = {}): void {
    const repo = this.repo(repoName);
    const head = this.resolve(repo, sha);
    const status = s.status ?? (s.conclusion ? 'completed' : 'in_progress');
    const workflow = s.workflow ?? 'CI';
    let run = repo.checkRuns.find((r) => r.headSha === head && r.name === name);
    const suiteId = repo.checkRuns.find((r) => r.headSha === head && r.workflow === workflow)?.suiteId ?? this.nextId();
    const created = !run;
    if (!run) {
      run = { id: this.nextId(), name, headSha: head, status, conclusion: null, suiteId, workflow, startedAt: this.tick(), completedAt: null };
      repo.checkRuns.push(run);
    }
    run.status = status;
    run.conclusion = status === 'completed' ? (s.conclusion ?? 'success') : null;
    run.completedAt = status === 'completed' ? this.tick() : null;
    this.enqueue(repo, 'check_run', { action: created && status !== 'completed' ? 'created' : status === 'completed' ? 'completed' : 'created', check_run: this.checkRunJson(repo, run) }, 'github-actions[bot]');
    const suite = repo.checkRuns.filter((r) => r.suiteId === run!.suiteId);
    if (status === 'completed' && suite.every((r) => r.status === 'completed')) {
      this.enqueue(repo, 'check_suite', { action: 'completed', check_suite: this.suiteJson(repo, run.suiteId) }, 'github-actions[bot]');
    }
  }

  /** Post a commit status (Statuses API) on `sha`; replaces the earlier status for the same context. Sends no webhook (buildd handles no `status` event). */
  setStatus(repoName: string, sha: string, context: string, state: CommitStatusState, description = ''): void {
    const repo = this.repo(repoName);
    const head = this.resolve(repo, sha);
    repo.statuses = repo.statuses.filter((x) => !(x.sha === head && x.context === context));
    const st: CommitStatus = { context, sha: head, state, description, updatedAt: this.tick() };
    repo.statuses.push(st);
  }

  /** Every named check green on `sha`, in one suite. */
  greenCi(repoName: string, sha: string, names: string[] = ['build']): void {
    for (const n of names) this.setCheck(repoName, sha, n, { conclusion: 'success' });
  }

  private pullOf(repo: Repo, number: number): Pr {
    const pr = repo.pulls.get(number);
    if (!pr) throw notFound();
    return pr;
  }

  private mergeInternal(repo: Repo, pr: Pr, o: { method: 'merge' | 'squash' | 'rebase'; sha?: string; by: string; title?: string }): string {
    if (pr.merged || pr.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
    if (o.sha && o.sha !== pr.headSha) throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
    const m = this.computeMergeable(repo, pr);
    if (m.state === 'dirty') throw new HttpError(405, 'Pull Request is not mergeable');
    if (m.state === 'draft') throw new HttpError(405, 'Pull Request is in draft state');
    if (m.blockedBy) throw new HttpError(405, m.blockedBy);
    if (m.state === 'behind') throw new HttpError(405, 'Head branch is out of date. Review and try the merge again.');
    const baseTip = repo.branches.get(pr.baseRef)!;
    const { tree } = this.threeWay(repo, baseTip, pr.headSha);
    const message = o.title ?? `${pr.title} (#${pr.number})`;
    const sha = this.newSha('merge');
    repo.commits.set(sha, { sha, parents: o.method === 'merge' ? [baseTip, pr.headSha] : [baseTip], tree, message, date: this.tick() });
    const snap = this.prJson(repo, pr, false);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = sha;
    pr.mergedBy = o.by;
    pr.mergedAt = pr.closedAt = pr.updatedAt = this.tick();
    this.moveBranch(repo, pr.baseRef, sha, { forced: false, pusher: o.by });
    this.emitPr(repo, pr, 'closed', snap, {}, o.by);
    return sha;
  }

  private updateBranchInternal(repo: Repo, pr: Pr, expected: string | undefined, by: string): string {
    if (pr.state !== 'open') throw new HttpError(422, 'Validation Failed: pull request is closed');
    if (expected && expected !== pr.headSha) throw new HttpError(422, "expected head sha didn't match current head ref.");
    const baseTip = repo.branches.get(pr.baseRef);
    if (!baseTip) throw new HttpError(422, 'Validation Failed: base branch does not exist');
    if (this.ancestors(repo, pr.headSha).has(baseTip)) throw new HttpError(422, 'There are no new commits on the base branch.');
    const { tree, conflicts } = this.threeWay(repo, pr.headSha, baseTip);
    if (conflicts.length) throw new HttpError(422, 'merge conflict between base and head');
    const sha = this.newSha('update-branch');
    repo.commits.set(sha, { sha, parents: [pr.headSha, baseTip], tree, message: `Merge branch '${pr.baseRef}' into ${pr.headRef}`, date: this.tick() });
    this.moveBranch(repo, pr.headRef, sha, { forced: false, pusher: by });
    return sha;
  }

  /** Someone else's commit on the PR's head, as `headMovesBeforeWrite` injects. */
  private interloperPush(repo: Repo, pr: Pr): void {
    const sha = this.makeCommit(repo, [pr.headSha], this.commit(repo, pr.headSha).tree, { [`interloper-${this.seq}.txt`]: 'x' }, 'concurrent push');
    this.moveBranch(repo, pr.headRef, sha, { forced: false, pusher: 'someone-else' });
  }

  // ── Mergeability ─────────────────────────────────────────────────────────

  private computeMergeable(repo: Repo, pr: Pr): { state: string; mergeable: boolean | null; blockedBy?: string } {
    if (pr.state !== 'open') return { state: 'unknown', mergeable: null };
    const baseTip = repo.branches.get(pr.baseRef);
    if (!baseTip) return { state: 'unknown', mergeable: null };
    if (this.threeWay(repo, baseTip, pr.headSha).conflicts.length) return { state: 'dirty', mergeable: false };
    if (pr.draft) return { state: 'draft', mergeable: true };
    const prot = repo.protection.get(pr.baseRef) ?? {};
    const runs = this.latestRuns(repo, pr.headSha);
    for (const name of prot.requiredChecks ?? []) {
      const r = runs.find((x) => x.name === name);
      if (!r || r.status !== 'completed') return { state: 'blocked', mergeable: true, blockedBy: `Required status check "${name}" is expected.` };
      if (!['success', 'neutral', 'skipped'].includes(String(r.conclusion))) return { state: 'blocked', mergeable: true, blockedBy: `Required status check "${name}" is failing.` };
    }
    const approvals = this.latestReviews(pr).filter((r) => r.state === 'APPROVED').length;
    const changes = this.latestReviews(pr).some((r) => r.state === 'CHANGES_REQUESTED');
    if ((prot.requiredApprovals ?? 0) > approvals || (prot.requiredApprovals && changes)) {
      return { state: 'blocked', mergeable: true, blockedBy: `At least ${prot.requiredApprovals} approving review is required by reviewers with write access.` };
    }
    if (prot.strict && !this.ancestors(repo, pr.headSha).has(baseTip)) return { state: 'behind', mergeable: true };
    if (runs.some((r) => r.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(String(r.conclusion)))) return { state: 'unstable', mergeable: true };
    if (repo.statuses.some((x) => x.sha === pr.headSha && x.state !== 'success')) return { state: 'unstable', mergeable: true };
    return { state: 'clean', mergeable: true };
  }

  /** Mergeability as a REST read sees it: unknown until GitHub has computed it for this (head, base tip). */
  private readMergeable(repo: Repo, pr: Pr, consume: boolean): { state: string; mergeable: boolean | null } {
    if (pr.state !== 'open') return { state: 'unknown', mergeable: null };
    const key = `${pr.headSha}:${repo.branches.get(pr.baseRef) ?? ''}`;
    if (pr.mergeability.key !== key) {
      if (!consume) return { state: 'unknown', mergeable: null };
      pr.mergeability = { key, unknownLeft: this.faults.mergeableUnknownReads ?? 0 };
    }
    if (pr.mergeability.unknownLeft > 0) {
      if (consume) pr.mergeability.unknownLeft--;
      return { state: 'unknown', mergeable: null };
    }
    return this.computeMergeable(repo, pr);
  }

  private latestReviews(pr: Pr): Review[] {
    const by = new Map<string, Review>();
    for (const r of pr.reviews) if (r.state !== 'COMMENTED') by.set(r.user, r);
    return [...by.values()];
  }

  private latestRuns(repo: Repo, sha: string): CheckRun[] {
    return repo.checkRuns.filter((r) => r.headSha === sha);
  }

  // ── JSON shapes (GitHub's REST and webhook payloads) ─────────────────────

  private userJson(login: string): Record<string, unknown> {
    const bot = login.endsWith('[bot]');
    return { login, id: hash32(login), node_id: `U_${hash32(login).toString(36)}`, type: bot ? 'Bot' : 'User', site_admin: false, html_url: `https://github.com/${login}`, url: `https://api.github.com/users/${login}` };
  }

  private repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: repo.fullName, private: false,
      owner: { ...this.userJson(repo.owner), type: 'Organization' },
      html_url: `https://github.com/${repo.fullName}`, url: `https://api.github.com/repos/${repo.fullName}`,
      default_branch: repo.defaultBranch, fork: false, archived: false, disabled: false,
    };
  }

  private refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
    return { label: `${repo.owner}:${ref}`, ref, sha, user: this.userJson(repo.owner), repo: this.repoJson(repo) };
  }

  /** `consume`: a REST read (counts toward `mergeableUnknownReads`). Webhook payloads carry GitHub's unknown, as real ones usually do. */
  private prJson(repo: Repo, pr: Pr, consume: boolean, forWebhook = false): Record<string, unknown> {
    const m = forWebhook || !consume ? { state: 'unknown', mergeable: null } : this.readMergeable(repo, pr, consume);
    const base = repo.branches.get(pr.baseRef) ?? '';
    const own = this.mergeBase(repo, pr.headSha, base || pr.headSha);
    const files = own ? Object.keys(this.diffTrees(this.commit(repo, own).tree, this.commit(repo, pr.headSha).tree)) : [];
    const url = `https://api.github.com/repos/${repo.fullName}/pulls/${pr.number}`;
    return {
      url, id: pr.id, node_id: `PR_${pr.id}`, html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
      diff_url: `https://github.com/${repo.fullName}/pull/${pr.number}.diff`,
      issue_url: `https://api.github.com/repos/${repo.fullName}/issues/${pr.number}`,
      number: pr.number, state: pr.state, locked: false, title: pr.title, body: pr.body, user: this.userJson(pr.user),
      created_at: pr.createdAt, updated_at: pr.updatedAt, closed_at: pr.closedAt, merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha, assignees: [], requested_reviewers: [], labels: [], draft: pr.draft,
      head: this.refJson(repo, pr.headRef, pr.headSha), base: this.refJson(repo, pr.baseRef, base),
      author_association: 'MEMBER', auto_merge: null,
      merged: pr.merged, mergeable: m.mergeable, rebaseable: m.mergeable, mergeable_state: m.state,
      merged_by: pr.mergedBy ? this.userJson(pr.mergedBy) : null,
      comments: [...repo.comments.values()].filter((c) => c.issue === pr.number).length, review_comments: 0,
      maintainer_can_modify: false, commits: Math.max(1, this.ancestors(repo, pr.headSha).size - (base ? this.ancestors(repo, base).size : 0)),
      additions: files.length, deletions: 0, changed_files: files.length,
    };
  }

  private reviewJson(repo: Repo, pr: Pr, r: Review, forWebhook: boolean): Record<string, unknown> {
    return {
      id: r.id, node_id: `PRR_${r.id}`, user: this.userJson(r.user), body: r.body,
      // Webhook review states are lowercase; REST's are uppercase.
      state: forWebhook ? r.state.toLowerCase() : r.state,
      commit_id: r.commitId, submitted_at: r.submittedAt, author_association: 'MEMBER',
      html_url: `https://github.com/${repo.fullName}/pull/${pr.number}#pullrequestreview-${r.id}`,
      pull_request_url: `https://api.github.com/repos/${repo.fullName}/pulls/${pr.number}`,
    };
  }

  private prRefsFor(repo: Repo, sha: string): Array<Record<string, unknown>> {
    return [...repo.pulls.values()].filter((p) => p.state === 'open' && p.headSha === sha).map((p) => ({
      url: `https://api.github.com/repos/${repo.fullName}/pulls/${p.number}`, id: p.id, number: p.number,
      head: { ref: p.headRef, sha: p.headSha, repo: { id: repo.id, url: `https://api.github.com/repos/${repo.fullName}`, name: repo.name } },
      base: { ref: p.baseRef, sha: repo.branches.get(p.baseRef) ?? '', repo: { id: repo.id, url: `https://api.github.com/repos/${repo.fullName}`, name: repo.name } },
    }));
  }

  private checkRunJson(repo: Repo, r: CheckRun): Record<string, unknown> {
    return {
      id: r.id, node_id: `CR_${r.id}`, name: r.name, head_sha: r.headSha, external_id: '', status: r.status, conclusion: r.conclusion,
      started_at: r.startedAt, completed_at: r.completedAt, html_url: `https://github.com/${repo.fullName}/runs/${r.id}`,
      details_url: `https://github.com/${repo.fullName}/actions/runs/${r.suiteId}/job/${r.id}`,
      check_suite: { id: r.suiteId }, app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
      output: { title: null, summary: null, text: null, annotations_count: 0 }, pull_requests: this.prRefsFor(repo, r.headSha),
    };
  }

  private suiteJson(repo: Repo, suiteId: number): Record<string, unknown> {
    const runs = repo.checkRuns.filter((r) => r.suiteId === suiteId);
    const done = runs.every((r) => r.status === 'completed');
    const order = ['action_required', 'cancelled', 'timed_out', 'failure', 'startup_failure', 'neutral', 'skipped', 'success'];
    const conclusion = done ? (order.find((c) => runs.some((r) => r.conclusion === c)) ?? 'success') : null;
    const sha = runs[0]?.headSha ?? '';
    const branch = [...repo.branches.entries()].find(([, s]) => s === sha)?.[0] ?? null;
    return {
      id: suiteId, node_id: `CS_${suiteId}`, head_branch: branch, head_sha: sha, status: done ? 'completed' : 'in_progress', conclusion,
      app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' }, pull_requests: this.prRefsFor(repo, sha),
      created_at: runs[0]?.startedAt, updated_at: this.now(), latest_check_runs_count: runs.length,
      check_runs_url: `https://api.github.com/repos/${repo.fullName}/check-suites/${suiteId}/check-runs`,
    };
  }

  private commitJson(repo: Repo, c: Commit): Record<string, unknown> {
    return {
      sha: c.sha, node_id: `C_${c.sha.slice(0, 8)}`, html_url: `https://github.com/${repo.fullName}/commit/${c.sha}`,
      commit: { message: c.message, author: { name: 'dev', email: 'dev@example.test', date: c.date }, committer: { name: 'dev', email: 'dev@example.test', date: c.date }, tree: { sha: hex40(`tree:${c.sha}`) } },
      parents: c.parents.map((p) => ({ sha: p, url: `https://api.github.com/repos/${repo.fullName}/commits/${p}` })),
    };
  }

  // ── Webhook emission and delivery ────────────────────────────────────────

  onWebhook(listener: WebhookListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  /** Webhooks queued and not yet handed over. */
  pendingWebhooks(): ReadonlyArray<WebhookDelivery> { return this.queue; }

  private enqueue(repo: Repo, name: WebhookDelivery['name'], body: Record<string, unknown>, sender: string, pr?: { pr: Pr; before: Record<string, unknown> | 'missing' }): void {
    this.queue.push({
      id: this.guid(), name,
      payload: { ...body, repository: this.repoJson(repo), organization: { login: repo.owner, id: hash32(repo.owner) }, sender: this.userJson(sender), installation: { id: this.installationId, node_id: `I_${this.installationId}` } },
      ...(pr ? { pr: { repo: repo.fullName, number: pr.pr.number, before: pr.before } } : {}),
    });
  }

  private emitPr(repo: Repo, pr: Pr, action: string, before: Record<string, unknown> | 'missing', extra: Record<string, unknown>, sender: string): void {
    this.enqueue(repo, 'pull_request', { action, number: pr.number, ...extra, pull_request: this.prJson(repo, pr, false, true) }, sender, { pr, before });
  }

  private emitPush(repo: Repo, branch: string, before: string, after: string, o: { created?: boolean; deleted?: boolean; forced: boolean; pusher: string }): void {
    const head = repo.commits.get(after);
    const commits = head ? [this.pushCommit(repo, head)] : [];
    this.enqueue(repo, 'push', {
      ref: `refs/heads/${branch}`, before, after, created: !!o.created, deleted: !!o.deleted, forced: o.forced, base_ref: null,
      compare: `https://github.com/${repo.fullName}/compare/${before.slice(0, 12)}...${after.slice(0, 12)}`,
      commits, head_commit: commits[0] ?? null, pusher: { name: o.pusher, email: `${o.pusher}@example.test` },
    }, o.pusher);
  }

  private pushCommit(repo: Repo, c: Commit): Record<string, unknown> {
    const parent = c.parents[0] ? repo.commits.get(c.parents[0]) : undefined;
    const d = this.diffTrees(parent?.tree ?? new Map(), c.tree);
    const keys = Object.keys(d);
    return {
      id: c.sha, tree_id: hex40(`tree:${c.sha}`), distinct: true, message: c.message, timestamp: c.date,
      url: `https://github.com/${repo.fullName}/commit/${c.sha}`,
      author: { name: 'dev', email: 'dev@example.test' }, committer: { name: 'dev', email: 'dev@example.test' },
      added: keys.filter((k) => d[k] !== null && !parent?.tree.has(k)), removed: keys.filter((k) => d[k] === null),
      modified: keys.filter((k) => d[k] !== null && parent?.tree.has(k)),
    };
  }

  /**
   * Hand every queued webhook to the listeners, in order, applying the webhook
   * faults; webhooks raised while delivering are delivered too. Returns how many
   * were handed over.
   */
  async deliverWebhooks(opts: { names?: Array<WebhookDelivery['name']> } = {}): Promise<number> {
    let handed = 0;
    for (let guard = 0; this.queue.length && guard < 10_000; guard++) {
      const i = opts.names ? this.queue.findIndex((h) => opts.names!.includes(h.name)) : 0;
      if (i < 0) break;
      if (i + 1 < this.queue.length && this.fires('webhookReorder')) {
        // The one behind it arrives first.
        [this.queue[i], this.queue[i + 1]] = [this.queue[i + 1], this.queue[i]];
      }
      const [hook] = this.queue.splice(i, 1);
      const delivery: WebhookDelivery = { id: hook.id, name: hook.name, payload: hook.payload };
      if (this.fires('webhookDrop')) { this.dropped.push(delivery); continue; }
      const copies = this.fires('webhookDuplicate') ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        const pr = hook.pr && c === 0 && this.fires('webhookEarly') ? this.repos.get(hook.pr.repo)?.pulls.get(hook.pr.number) : undefined;
        if (pr) pr.frozen = hook.pr!.before;
        try {
          this.delivered.push(delivery);
          handed++;
          for (const l of this.listeners) await l(structuredClone(delivery));
        } finally {
          if (pr) pr.frozen = null;
        }
      }
    }
    return handed;
  }

  /** Throw away queued webhooks (a test that drives facts by hand). */
  discardWebhooks(): void { this.queue.length = 0; }

  // ── REST ─────────────────────────────────────────────────────────────────

  /** One REST request, as GitHub would answer it. */
  async request(method: string, path: string, body?: unknown): Promise<FakeResponse> {
    const m = method.toUpperCase();
    const label = `${m} ${path}`;
    const callFault = !this.faults.callMatch || this.faults.callMatch.test(label);
    const shot = this.oneShots.findIndex((o) => o.match.test(label));
    let res: FakeResponse;
    if (shot >= 0) {
      const o = this.oneShots.splice(shot, 1)[0];
      res = { status: o.status, body: { message: o.message } };
    } else if (callFault && this.fires('rateLimit')) {
      res = { status: 403, body: { message: `API rate limit exceeded for installation ID ${this.installationId}.`, documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting' }, headers: { 'x-ratelimit-remaining': '0' } };
    } else if (callFault && this.fires('serverError')) {
      res = { status: 502, body: '<html><body><h1>502 Bad Gateway</h1></body></html>', headers: { 'content-type': 'text/html' } };
    } else {
      try {
        res = { status: 200, ...this.route(m, path, body) };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        res = { status: err.status, body: { message: err.message, documentation_url: 'https://docs.github.com/rest' } };
      }
      if (m !== 'GET' && res.status < 300 && callFault && this.fires('lostResponse')) {
        res = { status: 502, body: '', headers: { 'content-type': 'text/html' } };
      }
    }
    this.calls.push({ method: m, path, status: res.status });
    return res;
  }

  /** A `fetch` for `https://api.github.com/*`. */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    const raw = init.body ?? null;
    const body = typeof raw === 'string' && raw ? JSON.parse(raw) : undefined;
    const res = await this.request(method, url.pathname + url.search, body);
    const isText = typeof res.body === 'string';
    const headers = { 'content-type': isText ? (res.headers?.['content-type'] ?? 'text/plain') : 'application/json; charset=utf-8', ...(res.headers ?? {}) };
    if (res.status === 204) return new Response(null, { status: 204, headers });
    return new Response(isText ? (res.body as string) : JSON.stringify(res.body), { status: res.status, headers });
  };

  /** The `githubApi` signature, with its exact error format. */
  readonly api = async (_installationId: number, path: string, init: RequestInit = {}): Promise<any> => {
    const res = await this.fetch(`https://api.github.com${path}`, init);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
    if (res.status === 204) return null;
    return res.json();
  };

  /** The production `githubReader` over this fake. */
  reader(installationId = this.installationId): GithubFactReader {
    return githubReader(installationId, this.api);
  }

  /** Route `https://api.github.com/*` fetches here (everything else passes through). Returns the restore. */
  installFetch(): () => void {
    const original = globalThis.fetch;
    const fake = this.fetch;
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return href.startsWith('https://api.github.com/') ? fake(input, init) : original(input, init);
    }) as typeof fetch;
    globalThis.fetch = Object.assign(wrapped, { preconnect: (original as { preconnect?: unknown }).preconnect }) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  private route(method: string, fullPath: string, body: unknown): Omit<FakeResponse, 'status'> & { status?: number } {
    const [pathname, search = ''] = fullPath.split('?');
    const query = new URLSearchParams(search);
    const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const b = (body ?? {}) as Record<string, any>;

    if (seg[0] === 'app' && seg[1] === 'installations' && seg[3] === 'access_tokens' && method === 'POST') {
      return { status: 201, body: { token: `ghs_fake${seg[2]}`, expires_at: new Date(this.clock + 3600_000).toISOString() } };
    }
    if (seg[0] !== 'repos' || seg.length < 3) return this.unsupportedRoute(method, fullPath);
    const repo = this.repo(`${seg[1]}/${seg[2]}`);
    const rest = seg.slice(3);
    const [a, b1, c, d] = rest;

    if (rest.length === 0 && method === 'GET') return { body: this.repoJson(repo) };

    if (a === 'pulls') {
      if (!b1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const head = query.get('head')?.split(':').pop();
        const base = query.get('base');
        const list = [...repo.pulls.values()].filter((p) => (state === 'all' || p.state === state) && (!head || p.headRef === head) && (!base || p.baseRef === base));
        return { body: list.map((p) => this.prJson(repo, p, false)) };
      }
      const pr = this.pullOf(repo, Number(b1));
      if (!c && method === 'GET') {
        if (pr.frozen === 'missing') throw notFound();
        if (pr.frozen) return { body: pr.frozen };
        return { body: this.prJson(repo, pr, true) };
      }
      if (!c && method === 'PATCH') {
        if (b.state === 'closed') this.closePr(repo.fullName, pr.number, this.appLogin);
        else if (b.state === 'open') this.reopenPr(repo.fullName, pr.number, this.appLogin);
        if (typeof b.title === 'string') pr.title = b.title;
        if (typeof b.body === 'string') pr.body = b.body;
        if (typeof b.base === 'string') { if (!repo.branches.has(b.base)) throw new HttpError(422, 'Validation Failed'); this.retargetInternal(repo, pr, b.base, this.appLogin); }
        return { body: this.prJson(repo, pr, false) };
      }
      if (c === 'merge' && method === 'PUT') {
        if (pr.state === 'open' && b.sha === pr.headSha && this.fires('headMovesBeforeWrite')) this.interloperPush(repo, pr);
        const sha = this.mergeInternal(repo, pr, { method: b.merge_method ?? 'merge', sha: b.sha, by: this.appLogin, title: b.commit_title });
        return { body: { sha, merged: true, message: 'Pull Request successfully merged' } };
      }
      if (c === 'merge' && method === 'GET') {
        if (!pr.merged) throw notFound();
        return { status: 204, body: null };
      }
      if (c === 'update-branch' && method === 'PUT') {
        if (pr.state === 'open' && b.expected_head_sha === pr.headSha && this.fires('headMovesBeforeWrite')) this.interloperPush(repo, pr);
        this.updateBranchInternal(repo, pr, b.expected_head_sha, this.appLogin);
        return { status: 202, body: { message: 'Updating pull request branch.', url: `https://github.com/${repo.fullName}/pull/${pr.number}` } };
      }
      if (c === 'reviews' && method === 'GET') return { body: pr.reviews.map((r) => this.reviewJson(repo, pr, r, false)) };
      if (c === 'reviews' && method === 'POST') {
        const state = b.event === 'APPROVE' ? 'APPROVED' : b.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';
        if (b.commit_id && !repo.commits.has(b.commit_id)) throw new HttpError(422, 'Unprocessable Entity: commit_id is not part of the pull request');
        const id = this.review(repo.fullName, pr.number, { state, user: this.appLogin, body: b.body ?? '', commitId: b.commit_id ?? pr.headSha });
        return { body: this.reviewJson(repo, pr, pr.reviews.find((r) => r.id === id)!, false) };
      }
      if (c === 'files' && method === 'GET') {
        if (Number(query.get('page') ?? '1') > 1) return { body: [] };
        const base = repo.branches.get(pr.baseRef) ?? pr.headSha;
        return { body: this.compareFiles(repo, this.mergeBase(repo, pr.headSha, base) ?? pr.headSha, pr.headSha) };
      }
      if (c === 'commits' && method === 'GET') {
        const base = repo.branches.get(pr.baseRef) ?? '';
        const exclude = base ? this.ancestors(repo, base) : new Set<string>();
        return { body: [...this.ancestors(repo, pr.headSha)].filter((s) => !exclude.has(s)).reverse().map((s) => this.commitJson(repo, this.commit(repo, s))) };
      }
      return this.unsupportedRoute(method, fullPath);
    }

    if (a === 'commits' && b1) {
      const sha = this.resolve(repo, b1);
      if (!c && method === 'GET') return { body: this.commitJson(repo, this.commit(repo, sha)) };
      const runs = this.latestRuns(repo, this.checkSha(repo, sha));
      // GitHub pages lists at per_page (default 30, max 100); total_count is the whole list.
      const per = Math.min(Number(query.get('per_page') ?? 30) || 30, 100);
      const page = Math.max(Number(query.get('page') ?? 1) || 1, 1);
      const slice = <T>(xs: T[]): T[] => xs.slice((page - 1) * per, page * per);
      if (c === 'check-runs' && method === 'GET') return { body: { total_count: runs.length, check_runs: slice(runs).map((r) => this.checkRunJson(repo, r)) } };
      if (c === 'check-suites' && method === 'GET') {
        const suites = [...new Set(runs.map((r) => r.suiteId))].map((id) => this.suiteJson(repo, id));
        return { body: { total_count: suites.length, check_suites: suites } };
      }
      if (c === 'status' && method === 'GET') {
        // Combined status: latest per context; state is pending with no statuses at all.
        const sts = repo.statuses.filter((x) => x.sha === sha);
        const state = sts.length === 0 ? (runs.length ? 'success' : 'pending')
          : sts.some((x) => x.state === 'failure' || x.state === 'error') ? 'failure'
          : sts.some((x) => x.state === 'pending') ? 'pending' : 'success';
        return { body: { state, sha, total_count: sts.length, statuses: slice(sts).map((x) => ({ context: x.context, state: x.state, description: x.description, updated_at: x.updatedAt })) } };
      }
      return this.unsupportedRoute(method, fullPath);
    }

    if (a === 'actions' && b1 === 'runs' && !c && method === 'GET') {
      const sha = query.get('head_sha');
      const suites = [...new Set(repo.checkRuns.filter((r) => !sha || r.headSha === this.checkSha(repo, sha)).map((r) => r.suiteId))];
      const runs = suites.map((id) => {
        const s = this.suiteJson(repo, id) as Record<string, unknown>;
        const first = repo.checkRuns.find((r) => r.suiteId === id)!;
        return { id, name: first.workflow, head_sha: first.headSha, head_branch: s.head_branch, status: s.status, conclusion: s.conclusion, html_url: `https://github.com/${repo.fullName}/actions/runs/${id}`, run_attempt: 1, event: 'pull_request' };
      });
      return { body: { total_count: runs.length, workflow_runs: runs } };
    }

    if (a === 'branches' && b1 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.branches.get(name);
      if (!sha) throw new HttpError(404, 'Branch not found');
      return { body: { name, commit: this.commitJson(repo, this.commit(repo, sha)), protected: repo.protection.has(name) } };
    }

    if (a === 'git' && (b1 === 'ref' || b1 === 'refs') && c === 'heads') {
      const name = rest.slice(3).join('/');
      const sha = repo.branches.get(name);
      if (method === 'GET') {
        if (!sha) throw notFound();
        return { body: { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } } };
      }
      if (method === 'DELETE') { this.deleteBranch(repo.fullName, name); return { status: 204, body: null }; }
      if (method === 'PATCH') {
        if (!sha) throw new HttpError(422, 'Reference does not exist');
        if (!b.force && !this.ancestors(repo, b.sha).has(sha)) throw new HttpError(422, 'Update is not a fast forward');
        this.moveBranch(repo, name, b.sha, { forced: !!b.force, pusher: this.appLogin });
        return { body: { ref: `refs/heads/${name}`, object: { sha: b.sha, type: 'commit' } } };
      }
    }

    if (a === 'compare' && b1 && method === 'GET') {
      const spec = rest.slice(1).join('/');
      const [baseRef, headRef] = spec.includes('...') ? spec.split('...') : spec.split('..');
      const base = this.resolve(repo, baseRef);
      const head = this.resolve(repo, headRef);
      const mb = this.mergeBase(repo, base, head);
      const H = this.ancestors(repo, head);
      const B = this.ancestors(repo, base);
      const status = base === head ? 'identical' : H.has(base) ? 'ahead' : B.has(head) ? 'behind' : 'diverged';
      return {
        body: {
          status, ahead_by: [...H].filter((s) => !B.has(s)).length, behind_by: [...B].filter((s) => !H.has(s)).length,
          base_commit: this.commitJson(repo, this.commit(repo, base)), merge_base_commit: mb ? this.commitJson(repo, this.commit(repo, mb)) : null,
          total_commits: [...H].filter((s) => !B.has(s)).length, commits: [],
          files: mb ? this.compareFiles(repo, mb, head) : [],
        },
      };
    }

    if (a === 'issues') {
      if (c === 'comments' && method === 'GET') {
        if (Number(query.get('page') ?? '1') > 1) return { body: [] };
        return { body: [...repo.comments.values()].filter((x) => x.issue === Number(b1)).map((x) => this.commentJson(repo, x)) };
      }
      if (c === 'comments' && method === 'POST') {
        this.pullOf(repo, Number(b1));
        const at = this.tick();
        const cm: IssueComment = { id: this.nextId(), issue: Number(b1), body: String(b.body ?? ''), user: this.appLogin, createdAt: at, updatedAt: at };
        repo.comments.set(cm.id, cm);
        return { status: 201, body: this.commentJson(repo, cm) };
      }
      if (b1 === 'comments' && c) {
        const cm = repo.comments.get(Number(c));
        if (!cm) throw notFound();
        if (method === 'GET') return { body: this.commentJson(repo, cm) };
        if (method === 'PATCH') { cm.body = String(b.body ?? ''); cm.updatedAt = this.tick(); return { body: this.commentJson(repo, cm) }; }
        if (method === 'DELETE') { repo.comments.delete(cm.id); return { status: 204, body: null }; }
      }
    }
    void d;
    return this.unsupportedRoute(method, fullPath);
  }

  /** `staleChecks`: a read for a PR head answered with the previous head's runs. */
  private checkSha(repo: Repo, sha: string): string {
    const pr = [...repo.pulls.values()].find((p) => p.headSha === sha && p.previousHeads.length);
    if (pr && this.fires('staleChecks')) return pr.previousHeads.at(-1)!;
    return sha;
  }

  private compareFiles(repo: Repo, from: string, to: string): Array<Record<string, unknown>> {
    const a = this.commit(repo, from).tree;
    const z = this.commit(repo, to).tree;
    return Object.entries(this.diffTrees(a, z)).sort(([x], [y]) => x.localeCompare(y)).map(([filename, content]) => {
      const old = a.get(filename);
      const status = content === null ? 'removed' : old === undefined ? 'added' : 'modified';
      const lines = [...(old !== undefined ? old.split('\n').filter(Boolean).map((l) => `-${l}`) : []), ...(content !== null ? content.split('\n').filter(Boolean).map((l) => `+${l}`) : [])];
      return {
        filename, status, sha: content === null ? null : hex40(`blob:${content}`),
        additions: content === null ? 0 : content.split('\n').filter(Boolean).length,
        deletions: old === undefined ? 0 : old.split('\n').filter(Boolean).length,
        changes: lines.length, patch: `@@ -1 +1 @@\n${lines.join('\n')}`,
      };
    });
  }

  private commentJson(repo: Repo, c: IssueComment): Record<string, unknown> {
    return {
      id: c.id, node_id: `IC_${c.id}`, body: c.body, user: this.userJson(c.user), created_at: c.createdAt, updated_at: c.updatedAt,
      html_url: `https://github.com/${repo.fullName}/pull/${c.issue}#issuecomment-${c.id}`,
      issue_url: `https://api.github.com/repos/${repo.fullName}/issues/${c.issue}`, author_association: 'NONE',
    };
  }

  private unsupportedRoute(method: string, path: string): never {
    this.unsupported.push(`${method} ${path}`);
    throw new HttpError(404, 'Not Found (fake-github: route not modelled)');
  }
}
