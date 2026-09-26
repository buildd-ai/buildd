/**
 * build-initiatives.ts — generate the "initiatives" demo story.
 *
 *   bun run scripts/demo/stories/build-initiatives.ts
 *   → scripts/demo/stories/initiatives.json
 *
 * One team, eight initiatives, each in a shape the Initiatives list has to draw
 * honestly:
 *
 *   - in flight, with one mission waiting on an answer and one held
 *   - every mission done, a KPI evaluated as failing afterwards
 *   - one mission done with one task failed, nothing checked it
 *   - paused, every mission done, one mission still flagged held
 *   - planned, with a target date and a mission that has not started
 *   - completed
 *   - no missions yet
 *   - in flight and merging
 *
 * Everything is fictional: team, people, repo, runner, PR numbers.
 * Deterministic, so re-running produces the same file.
 */
import { writeFileSync } from 'fs';

const OUT = new URL('.', import.meta.url).pathname;
const REPO = 'https://github.com/tidewater-labs/harbor-app';
let prSeq = 410;
const nextPr = () => ++prSeq;
const prUrl = (n: number) => `${REPO}/pull/${n}`;

type Entity = Record<string, any>;

const missions: Entity[] = [];
const backgroundMissions: Entity[] = [];

interface TaskSpec {
  title: string;
  /** merged (default) | failed | running | waiting | pending | open_pr */
  state?: 'merged' | 'failed' | 'running' | 'waiting' | 'pending' | 'open_pr';
  phase?: [number, string];
  question?: string;
  options?: string[];
}

function mission(key: string, m: Entity, specs: TaskSpec[]) {
  missions.push({
    key,
    workspaceId: 'ws',
    description: m.description ?? `${m.title}.`,
    priority: 1,
    defaultOutputRequirement: 'pr_required',
    ...m,
  });
  const tasks = specs.map((s, i) => {
    const state = s.state ?? 'merged';
    const t: Entity = {
      key: `${key}_t${i + 1}`,
      workspaceId: 'ws',
      missionId: key,
      title: s.title,
      roleSlug: s.title.startsWith('RESEARCH') ? 'researcher' : 'builder',
      kind: s.title.startsWith('RESEARCH') ? 'research' : 'engineering',
      outputRequirement: s.title.startsWith('RESEARCH') ? 'artifact_required' : 'pr_required',
      creationSource: 'mcp',
      ...(s.phase ? { missionPhaseIndex: s.phase[0], missionPhaseLabel: s.phase[1] } : {}),
    };
    if (state === 'merged') {
      const pr = nextPr();
      t.status = 'completed';
      t._worker = { runner: 'tern', status: 'completed', prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'merged', linesAdded: 40 + i * 7, linesRemoved: 8 + i };
    } else if (state === 'open_pr') {
      const pr = nextPr();
      t.status = 'completed';
      t._worker = { runner: 'tern', status: 'completed', prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'open', linesAdded: 52, linesRemoved: 11 };
    } else if (state === 'failed') {
      t.status = 'failed';
      t._worker = { runner: 'tern', status: 'error', error: 'Tests failed after 3 attempts' };
    } else if (state === 'running') {
      t.status = 'in_progress';
      t._worker = { runner: 'tern', status: 'running', progress: 55, progressLabel: 'Editing files' };
    } else if (state === 'waiting') {
      t.status = 'in_progress';
      t._worker = { runner: 'tern', status: 'waiting_input', question: s.question ?? 'Which way?', options: s.options ?? [] };
    } else {
      t.status = 'pending';
    }
    return t;
  });
  backgroundMissions.push({ missionKey: key, tasks });
}

// ── 1. Public API v2: in flight, one mission needs an answer, one held ──────
mission('M_api_auth', { title: 'API keys and scopes', initiativeId: 'I_api', status: 'completed', _createdAgo: '-9d', _completedAgo: '-6d', goalCriteria: [{ type: 'all_prs_merged' }], goalCriteriaState: { overall: 'pass' } }, [
  { title: 'feat(db): api_keys table with scopes' },
  { title: 'feat(api): issue and revoke keys' },
  { title: 'feat(api): scope checks on every route' },
  { title: 'feat(ui): keys page in settings' },
  { title: 'docs(api): authentication guide' },
]);
mission('M_api_docs', { title: 'Reference docs from the schema', initiativeId: 'I_api', status: 'active', _createdAgo: '-2d' }, [
  { title: 'RESEARCH: doc generators that read OpenAPI', phase: [1, 'Foundations'] },
  { title: 'feat(docs): generate pages from the schema', phase: [1, 'Foundations'] },
  { title: 'feat(docs): runnable examples per endpoint', state: 'running', phase: [2, 'Pages'] },
  { title: 'feat(docs): versioned URLs', state: 'waiting', phase: [2, 'Pages'], question: 'Keep v1 docs at /v1 or move them to an archive page?', options: ['Keep at /v1', 'Archive page'] },
  { title: 'feat(docs): search across endpoints', state: 'pending', phase: [2, 'Pages'] },
]);
mission('M_api_sdk', { title: 'TypeScript SDK', initiativeId: 'I_api', status: 'active', isHeld: true, _createdAgo: '-1d' }, [
  { title: 'feat(sdk): generated client', state: 'pending' },
  { title: 'feat(sdk): retries and rate-limit backoff', state: 'pending' },
  { title: 'docs(sdk): quickstart', state: 'pending' },
]);

// ── 2. Faster checkout: every mission done, KPI failing afterwards ──────────
const checkoutA: TaskSpec[] = Array.from({ length: 10 }, (_, i) => ({ title: [
  'perf(cart): cache the price lookup', 'perf(cart): drop the second tax call', 'perf(web): lazy-load the address form',
  'perf(web): preload the payment script', 'fix(cart): stop re-rendering on every keystroke', 'perf(api): batch stock checks',
  'perf(api): index orders by session', 'perf(web): inline critical CSS', 'fix(cart): debounce coupon validation', 'perf(api): trim the order payload',
][i] }));
const checkoutB: TaskSpec[] = Array.from({ length: 9 }, (_, i) => ({ title: [
  'feat(pay): one-tap wallet button', 'feat(pay): remember the last card', 'feat(pay): inline card errors', 'fix(pay): keep the form on a 3DS bounce',
  'feat(pay): guest checkout without an account', 'fix(pay): retry a timed-out capture once', 'feat(web): progress steps in the header',
  'feat(web): summary sticky on mobile', 'docs(pay): the checkout flow',
][i] }));
mission('M_co_speed', { title: 'Cut checkout load time', initiativeId: 'I_checkout', status: 'completed', _createdAgo: '-14d', _completedAgo: '-8d', goalCriteria: [{ type: 'all_prs_merged' }], goalCriteriaState: { overall: 'pass' } }, checkoutA);
mission('M_co_pay', { title: 'Fewer payment steps', initiativeId: 'I_checkout', status: 'completed', _createdAgo: '-9d', _completedAgo: '-4d', goalCriteria: [{ type: 'all_prs_merged' }], goalCriteriaState: { overall: 'pass' } }, checkoutB);

// ── 3. Accessibility pass: one mission done, one task failed, unchecked ────
mission('M_a11y', { title: 'Keyboard and screen reader fixes', initiativeId: 'I_a11y', status: 'completed', _createdAgo: '-6d', _completedAgo: '-3d' }, [
  { title: 'fix(ui): focus rings on every control' },
  { title: 'fix(ui): labels on icon buttons' },
  { title: 'fix(ui): skip-to-content link' },
  { title: 'fix(ui): announce toast messages', state: 'failed' },
]);

// ── 4. Offline mode: paused, every mission done, one still flagged held ────
const offlineA: TaskSpec[] = ['feat(sync): local queue for writes', 'feat(sync): replay on reconnect', 'fix(sync): dedupe replayed writes', 'feat(ui): offline banner'].map((title) => ({ title }));
const offlineB: TaskSpec[] = ['feat(sync): conflict prompt', 'feat(sync): keep both versions', 'docs(sync): how conflicts resolve'].map((title) => ({ title }));
mission('M_off_queue', { title: 'Write queue', initiativeId: 'I_offline', status: 'completed', _createdAgo: '-40d', _completedAgo: '-33d' }, offlineA);
mission('M_off_conflict', { title: 'Conflict handling', initiativeId: 'I_offline', status: 'completed', isHeld: true, _createdAgo: '-34d', _completedAgo: '-30d' }, offlineB);

// ── 5. Team billing: planned, target date, a mission not started ───────────
mission('M_bill_seats', { title: 'Seat-based plans', initiativeId: 'I_billing', status: 'active', _createdAgo: '-1d' }, [
  { title: 'RESEARCH: how seat changes prorate', state: 'pending' },
  { title: 'feat(db): plans and seats', state: 'pending' },
  { title: 'feat(billing): invoice on seat change', state: 'pending' },
]);

// ── 6. Search relevance: completed ──────────────────────────────────────────
mission('M_search', { title: 'Rank by recent activity', initiativeId: 'I_search', status: 'completed', _createdAgo: '-50d', _completedAgo: '-44d', goalCriteria: [{ type: 'all_prs_merged' }], goalCriteriaState: { overall: 'pass' } }, [
  { title: 'feat(search): recency boost' },
  { title: 'feat(search): typo tolerance' },
  { title: 'perf(search): cache top queries' },
]);

// ── 8. CSV import: in flight and merging ────────────────────────────────────
mission('M_import', { title: 'Import contacts from CSV', initiativeId: 'I_import', status: 'active', _createdAgo: '-3h' }, [
  { title: 'feat(import): parse and preview the file', phase: [1, 'Parse'] },
  { title: 'feat(import): map columns to fields', phase: [1, 'Parse'] },
  { title: 'feat(import): dedupe against existing contacts', state: 'open_pr', phase: [2, 'Write'] },
  { title: 'feat(import): background job with progress', state: 'running', phase: [2, 'Write'] },
  { title: 'feat(ui): import history page', state: 'pending', phase: [2, 'Write'] },
]);

const story = {
  _meta: {
    purpose: 'Synthetic team with one initiative per shape the Initiatives list must draw. Generated by build-initiatives.ts; every name, repo and number is fictional.',
    wallClockSeconds: 0,
  },
  team: { key: 'team', name: 'Tidewater Labs', slug: 'tidewater-labs', timezone: 'UTC' },
  users: [
    { key: 'u_ines', name: 'Ines Okafor', email: 'ines@tidewater.example' },
    { key: 'u_marek', name: 'Marek Lind', email: 'marek@tidewater.example' },
  ],
  accounts: [
    { key: 'acct_fleet', type: 'user', level: 'worker', name: 'tidewater-fleet', authType: 'oauth', maxConcurrentWorkers: 4, apiKey: 'bld_demo_initiatives_not_a_real_key_00', apiKeyPrefix: 'bld_demo' },
  ],
  runners: [{ key: 'tern', runner: 'tern', localUiUrl: 'http://tern.local:8766', maxConcurrentWorkers: 4 }],
  workspace: {
    key: 'ws', name: 'harbor-app', repo: REPO, accessMode: 'restricted', configStatus: 'admin_confirmed',
    gitConfig: { defaultBranch: 'main', branchingStrategy: 'trunk', branchStrategy: 'direct', commitStyle: 'conventional', requiresPR: true, targetBranch: 'main', autoCreatePR: true },
    _github: { fullName: 'tidewater-labs/harbor-app' },
  },
  roles: [
    { key: 'organizer', slug: 'organizer', name: 'Organizer', color: '#6366F1', model: 'sonnet', isRole: true, description: 'Plans missions into tasks' },
    { key: 'builder', slug: 'builder', name: 'Builder', color: '#0C72CB', model: 'opus', isRole: true, description: 'Writes code and opens PRs' },
    { key: 'researcher', slug: 'researcher', name: 'Researcher', color: '#B24C9C', model: 'sonnet', isRole: true, description: 'Investigates and reports' },
  ],
  initiatives: [
    { key: 'I_api', title: 'Public API v2', description: 'Let customers build on us without asking for a key by email.', status: 'active', priority: 5, ownerUserId: 'u_ines', _targetIn: '+18d', _createdAgo: '-12d', _updatedAgo: '-1d' },
    {
      key: 'I_checkout', title: 'Faster checkout', description: 'Fewer people should drop off between cart and payment.', status: 'active', priority: 4, ownerUserId: 'u_marek', _targetIn: '+2d', _createdAgo: '-20d', _updatedAgo: '-1d',
      kpis: [{ name: 'Checkout completion', metric: 'checkout.completion_rate_pct', operator: 'gte', threshold: 70, unit: '%', blocking: true }],
      kpiState: { evaluatedBy: 'auto', overall: 'fail', kpis: [{ index: 0, name: 'Checkout completion', verdict: 'fail', observedValue: 61, evidence: '61% over the last 7 days' }] },
      _kpiEvaluatedAgo: '-1d',
    },
    { key: 'I_a11y', title: 'Accessibility pass', description: 'Every screen usable with a keyboard and a screen reader.', status: 'active', priority: 3, ownerUserId: 'u_ines', _createdAgo: '-8d', _updatedAgo: '-3d' },
    { key: 'I_offline', title: 'Offline mode', description: 'Keep working on a train.', status: 'paused', priority: 2, ownerUserId: 'u_marek', _createdAgo: '-45d', _updatedAgo: '-29d' },
    { key: 'I_billing', title: 'Team billing', description: 'One invoice per team, billed by seat.', status: 'planned', priority: 2, ownerUserId: 'u_marek', _targetIn: '+45d', _createdAgo: '-2d', _updatedAgo: '-1d' },
    { key: 'I_search', title: 'Search relevance', description: 'The thing you meant shows up first.', status: 'completed', priority: 1, ownerUserId: 'u_ines', _createdAgo: '-55d', _updatedAgo: '-43d' },
    { key: 'I_mobile', title: 'Mobile app', description: 'A phone app for the parts people use on the go.', status: 'active', priority: 0, ownerUserId: 'u_ines', _createdAgo: '-1d', _updatedAgo: '-1d' },
    { key: 'I_import', title: 'Data import', description: 'Bring contacts and history over from the old tool.', status: 'active', priority: 4, ownerUserId: 'u_marek', _targetIn: '+9d', _createdAgo: '-4d', _updatedAgo: '-1h' },
  ],
  missions,
  backgroundMissions,
  tasks: [],
  workers: [],
  missionNotes: [],
  memories: [],
  artifacts: [],
  timeline: [],
};

writeFileSync(OUT + 'initiatives.json', JSON.stringify(story, null, 1) + '\n');
console.log(`wrote initiatives.json: ${story.initiatives.length} initiatives, ${missions.length} missions`);
