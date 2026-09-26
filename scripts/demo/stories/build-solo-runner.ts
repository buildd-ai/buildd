/**
 * build-solo-runner.ts — generate the "solo runner" demo story.
 *
 *   bun run scripts/demo/stories/build-solo-runner.ts
 *   → scripts/demo/stories/solo-runner.json       (fleet idle, as most real days end)
 *   → scripts/demo/stories/solo-runner-busy.json  (same, with three agents running)
 *
 * Shaped like an ordinary single-machine workspace rather than the demo video's
 * four-runner burst: one runner with ten slots and nothing on most of them, a
 * long tail of finished missions, a schedule that next fires months from now,
 * a row of doc fixes that shipped and wait on the same conformance re-run, one
 * discrepancy the owner has to decide, and runs that lasted a minute or two.
 *
 * Everything is fictional: team, people, repo, runner, PR numbers. The output
 * is deterministic (seeded PRNG) so re-running produces the same file.
 */
import { writeFileSync } from 'fs';

const OUT = new URL('.', import.meta.url).pathname;

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng(20260926);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

const REPO = 'https://github.com/kestrel-works/field-notes';
const RUNNER_URL = 'http://quill-studio-workstation.local:8766';
let prSeq = 640;
const nextPr = () => ++prSeq;
const prUrl = (n: number) => `${REPO}/pull/${n}`;

const AREAS = [
  'search', 'exports', 'billing page', 'onboarding', 'settings', 'notifications', 'audit log', 'webhooks',
  'api docs', 'dark mode', 'sync', 'reports', 'uploads', 'permissions', 'calendar', 'mobile nav', 'emails',
  'cache', 'imports', 'metrics', 'sharing', 'tags', 'comments', 'offline mode',
] as const;
const MISSION_VERBS = ['Speed up', 'Polish', 'Fix flaky', 'Add filters to', 'Rework', 'Harden', 'Document', 'Instrument', 'Simplify', 'Localise'];
const scopeOf = (area: string) => area.split(' ')[0];
const TASK_SHAPES: Array<(a: string) => { title: string; roleSlug: string; kind: string; taskClass?: string }> = [
  (a) => ({ title: `feat(${scopeOf(a)}): ${pick(['add', 'support', 'show'])} ${a} ${pick(['filters', 'empty state', 'bulk actions', 'keyboard shortcuts'])}`, roleSlug: 'builder', kind: 'engineering' }),
  (a) => ({ title: `fix(${scopeOf(a)}): ${pick(['stop', 'avoid', 'handle'])} ${pick(['double submit', 'stale counts', 'timezone drift', 'empty rows'])} in ${a}`, roleSlug: 'builder', kind: 'engineering' }),
  (a) => ({ title: `perf(${scopeOf(a)}): cache the ${a} query`, roleSlug: 'builder', kind: 'engineering' }),
  (a) => ({ title: `docs(${scopeOf(a)}): explain how ${a} works`, roleSlug: 'builder', kind: 'engineering' }),
  (a) => ({ title: `RESEARCH: how other tools handle ${a}`, roleSlug: 'researcher', kind: 'research' }),
  // The generic-scope shape a real workspace is full of: "pr" names nothing.
  () => ({ title: `fix(pr): keep the PR body in sync after a force-push`, roleSlug: 'builder', kind: 'engineering', taskClass: 'attempt' }),
];

type Entity = Record<string, any>;

function doneMission(i: number): { mission: Entity; bg: Entity } {
  const area = AREAS[i % AREAS.length];
  const key = `H${i}`;
  const createdDays = 3 + Math.floor((i / 112) * 150) + Math.floor(rand() * 2);
  const durH = 1 + Math.floor(rand() * 20);
  const nTasks = 1 + Math.floor(rand() * 3);
  const mission = {
    key, workspaceId: 'ws', title: `${pick(MISSION_VERBS)} ${area}`, description: `Finished work on ${area}.`,
    status: 'completed', priority: 1, _createdAgo: `-${createdDays}d`, _completedAgo: `-${Math.max(1, createdDays * 24 - durH)}h`,
    goalCriteria: [{ type: 'all_prs_merged', label: 'every task PR merged' }], goalCriteriaState: { overall: 'pass' },
  };
  const tasks = Array.from({ length: nTasks }, (_, j) => {
    const shape = pick(TASK_SHAPES.slice(0, 5))(area);
    const pr = shape.kind === 'research' ? null : nextPr();
    return {
      key: `${key}_t${j}`, workspaceId: 'ws', missionId: key, ...shape, status: 'completed',
      outputRequirement: pr ? 'pr_required' : 'artifact_required',
      _worker: {
        runner: 'quill', status: 'completed', ...(pr ? { prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'merged' } : {}),
        linesAdded: 20 + Math.floor(rand() * 300), linesRemoved: Math.floor(rand() * 120),
      },
    };
  });
  return { mission, bg: { missionKey: key, tasks } };
}

const SPECS = ['exports-csv', 'webhook-retries', 'search-filters', 'notification-digest', 'audit-log', 'billing-page'];

function build(busy: boolean) {
  const history = Array.from({ length: 112 }, (_, i) => doneMission(i));

  // ── the conformance sweep: doc fixes that each ran for a couple of minutes today ──
  const docFixTasks = SPECS.map((spec, i) => {
    const pr = nextPr();
    const endMin = 25 + i * 47; // newest ended 25 minutes ago
    return {
      key: `DF${i}`, workspaceId: 'ws', missionId: 'M_conf', title: `docs(specs): reconcile ${spec}.md with the shipped code`,
      label: `reconcile ${spec} spec`, roleSlug: 'builder', kind: 'engineering', status: 'completed', outputRequirement: 'pr_required',
      _startedAgo: `-${endMin + 2 + (i % 3)}m`, _endedAgo: `-${endMin}m`,
      _worker: { runner: 'quill', status: 'completed', prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'merged', linesAdded: 12 + i * 3, linesRemoved: 6 + i, _mergedAgo: `-${Math.max(5, endMin - 8)}m` },
    };
  });
  // Yesterday's doc fix that merged, was rechecked, and still did not close the gap.
  const stuckPr = nextPr();
  docFixTasks.push({
    key: 'DF_uploads', workspaceId: 'ws', missionId: 'M_conf', title: 'docs(specs): reconcile uploads.md with the shipped code',
    label: 'reconcile uploads spec', roleSlug: 'builder', kind: 'engineering', status: 'completed', outputRequirement: 'pr_required',
    _startedAgo: '-27h', _endedAgo: '-1605m',
    _worker: { runner: 'quill', status: 'completed', prNumber: stuckPr, prUrl: prUrl(stuckPr), prLifecycleStatus: 'merged', linesAdded: 18, linesRemoved: 9, _mergedAgo: '-26h' },
  } as any);

  // A few one-minute runs: verification ticks and a retry with a generic scope.
  const shortRuns = [
    { key: 'SR0', title: 'Verify goal criterion: every doc-fix PR merged', label: null, roleSlug: 'organizer', kind: 'coordination', _startedAgo: '-58m', _endedAgo: '-57m', pr: false },
    { key: 'SR1', title: 'fix(pr): keep the PR body in sync after a force-push', label: null, roleSlug: 'builder', kind: 'engineering', taskClass: 'attempt', _startedAgo: '-96m', _endedAgo: '-93m', pr: true },
    { key: 'SR2', title: 'Verify goal criterion: conformance re-run is green', label: null, roleSlug: 'organizer', kind: 'coordination', _startedAgo: '-3h', _endedAgo: '-179m', pr: false },
  ].map((r) => {
    const pr = r.pr ? nextPr() : null;
    const { pr: _p, ...rest } = r;
    return {
      ...rest, workspaceId: 'ws', missionId: 'M_conf', status: 'completed', outputRequirement: pr ? 'pr_required' : 'none',
      _worker: { runner: 'quill', status: 'completed', ...(pr ? { prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'merged' } : {}) },
    };
  });

  const liveTasks = busy
    ? [
        { key: 'L0', title: 'feat(onboarding): checklist progress survives a reload', startedAgo: '-12m', progress: 55 },
        { key: 'L1', title: 'fix(sync): retry the upload queue after the laptop wakes', startedAgo: '-31m', progress: 80 },
        { key: 'L2', title: 'RESEARCH: which checklist steps new teams skip', startedAgo: '-4m', progress: 15, roleSlug: 'researcher', kind: 'research' },
      ].map((t) => ({
        key: t.key, workspaceId: 'ws', missionId: 'M_onb', title: t.title, roleSlug: t.roleSlug ?? 'builder', kind: t.kind ?? 'engineering',
        status: 'in_progress', outputRequirement: t.kind === 'research' ? 'artifact_required' : 'pr_required', _startedAgo: t.startedAgo,
        _worker: { runner: 'quill', status: 'running', progress: t.progress, progressLabel: 'Editing files' },
      }))
    : [];

  const onboardingTasks = [
    { key: 'OB0', title: 'feat(onboarding): first-run checklist component', status: 'completed', pr: true, ago: '-6d', ended: '-143h' },
    { key: 'OB1', title: 'feat(onboarding): persist checklist state per team', status: 'failed', pr: false, ago: '-5d', ended: '-119h' },
    { key: 'OB2', title: 'feat(onboarding): celebrate the last checked step', status: 'pending', pr: false, ago: null, ended: null, dependsOn: ['OB1'] },
  ].map((t) => {
    const pr = t.pr ? nextPr() : null;
    return {
      key: t.key, workspaceId: 'ws', missionId: 'M_onb', title: t.title, roleSlug: 'builder', kind: 'engineering', status: t.status,
      outputRequirement: 'pr_required', ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}),
      ...(t.ago ? { _startedAgo: t.ago, _endedAgo: t.ended } : {}),
      ...(t.status === 'pending' ? {} : {
        _worker: { runner: 'quill', status: t.status === 'failed' ? 'failed' : 'completed', ...(pr ? { prNumber: pr, prUrl: prUrl(pr), prLifecycleStatus: 'merged' } : {}) },
      }),
    };
  });

  const discrepancies: Entity[] = [];
  SPECS.forEach((spec, i) => {
    const n = 2 + (i % 2);
    for (let j = 0; j < n; j++) {
      discrepancies.push({
        key: `SD_${spec}_${j}`, specPath: `docs/specs/${spec}.md`, assertionId: `${spec.slice(0, 3).toUpperCase()}-${j + 1}`,
        direction: 'code_ahead', status: 'open', docFixTaskId: `DF${i}`, _firstSeenAgo: '-2d', _lastCheckedAgo: '-20h',
      });
    }
  });
  // Rechecked after its doc fix merged, and still open: the owner's call.
  for (let j = 0; j < 2; j++) {
    discrepancies.push({
      key: `SD_uploads_${j}`, specPath: 'docs/specs/uploads.md', assertionId: `UPL-${j + 1}`,
      direction: 'code_ahead', status: 'open', docFixTaskId: 'DF_uploads', _firstSeenAgo: '-4d', _lastCheckedAgo: '-2h',
    });
  }

  return {
    _meta: {
      purpose: 'Synthetic single-runner workspace for checking Home against real-shaped data (fleet mostly idle, long mission history, far-future schedule, repeated doc-fix cards). Generated by build-solo-runner.ts; every name, repo and number is fictional.',
      wallClockSeconds: 0,
    },
    team: { key: 'team', name: 'Kestrel Works', slug: 'kestrel-works', timezone: 'Europe/Lisbon' },
    users: [{ key: 'u_rowan', name: 'Rowan Ellis', email: 'rowan@kestrel.example' }],
    accounts: [
      { key: 'acct_fleet', type: 'user', level: 'worker', name: 'kestrel-fleet', authType: 'oauth', maxConcurrentWorkers: 10, apiKey: 'bld_demo_solo_runner_not_a_real_key_0', apiKeyPrefix: 'bld_demo' },
    ],
    runners: [
      { key: 'quill', runner: 'quill', localUiUrl: RUNNER_URL, maxConcurrentWorkers: 10, _display: 'quill-studio-workstation · Mac mini' },
    ],
    heartbeatRunner: 'quill',
    workspace: {
      key: 'ws', name: 'field-notes', repo: REPO, accessMode: 'restricted', configStatus: 'admin_confirmed',
      gitConfig: { defaultBranch: 'main', branchingStrategy: 'trunk', branchStrategy: 'direct', commitStyle: 'conventional', requiresPR: true, targetBranch: 'main', autoCreatePR: true },
      _github: { fullName: 'kestrel-works/field-notes' },
    },
    roles: [
      { key: 'organizer', slug: 'organizer', name: 'Organizer', color: '#6366F1', model: 'sonnet', isRole: true, description: 'Plans missions into tasks' },
      { key: 'builder', slug: 'builder', name: 'Builder', color: '#0C72CB', model: 'opus', isRole: true, description: 'Writes code and opens PRs' },
      { key: 'researcher', slug: 'researcher', name: 'Researcher', color: '#B24C9C', model: 'sonnet', isRole: true, description: 'Investigates and reports' },
    ],
    initiatives: [
      { key: 'I_docs', title: 'Docs you can trust', status: 'active', priority: 2, _createdAgo: '-40d', _updatedAgo: '-1d' },
      { key: 'I_onb', title: 'Self-serve onboarding', status: 'active', priority: 1, _createdAgo: '-30d', _updatedAgo: '-5d' },
      { key: 'I_search', title: 'Faster search', status: 'active', priority: 0, _createdAgo: '-60d', _updatedAgo: '-9d' },
    ],
    missions: [
      {
        key: 'M_conf', workspaceId: 'ws', initiativeId: 'I_docs', title: 'Spec conformance sweep', description: 'Bring every spec back in line with the shipped code.',
        status: 'active', priority: 3, _createdAgo: '-2d', goalCriteria: [{ type: 'all_prs_merged', label: 'every doc-fix PR merged' }, { type: 'no_open_tasks', label: 'no open tasks' }],
      },
      {
        key: 'M_onb', workspaceId: 'ws', initiativeId: 'I_onb', title: 'Guided first-run checklist', description: 'A checklist that walks a new team through setup.',
        status: 'active', priority: 2, _createdAgo: '-7d', goalCriteria: [{ type: 'all_prs_merged', label: 'every task PR merged' }],
      },
      {
        key: 'M_audit', workspaceId: 'ws', title: 'Twice-yearly licence audit', description: 'Check every dependency licence against the allow-list.',
        status: 'active', orchestrationMode: 'auto', priority: 0, scheduleId: 'S_audit', _createdAgo: '-250d',
      },
      ...history.map((h) => ({ ...h.mission, ...(h.mission.key.endsWith('7') ? { initiativeId: 'I_search' } : {}) })),
    ],
    taskSchedules: [
      {
        key: 'S_audit', workspaceId: 'ws', name: 'Mission: Twice-yearly licence audit', cronExpression: '0 9 1 1,7 *', timezone: 'Europe/Lisbon', enabled: true,
        maxConcurrentFromSchedule: 1, totalRuns: 3, consecutiveFailures: 0, _nextRunIn: '111d', _lastRunAgo: '72d',
        taskTemplate: { title: 'Mission: Twice-yearly licence audit', mode: 'planning', context: { missionId: 'M_audit', heartbeat: true } },
      },
    ],
    heartbeatPastTicks: [
      { agoHours: (111 + 72) * 24, summary: 'All 212 licences on the allow-list.' },
      { agoHours: (111 + 72 + 181) * 24, summary: 'One copyleft transitive dependency flagged; task filed.' },
    ],
    backgroundMissions: [
      { missionKey: 'M_conf', tasks: [...docFixTasks, ...shortRuns] },
      { missionKey: 'M_onb', tasks: [...onboardingTasks, ...liveTasks] },
      ...history.map((h) => h.bg),
    ],
    specDiscrepancies: discrepancies,
    tasks: [],
    workers: [],
    memories: [],
    artifacts: [],
    timeline: [],
  };
}

for (const [file, busy] of [['solo-runner.json', false], ['solo-runner-busy.json', true]] as const) {
  prSeq = 640;
  rand = rng(20260926);
  writeFileSync(OUT + file, JSON.stringify(build(busy), null, 1) + '\n');
  console.log(`[build-solo-runner] wrote ${file}`);
}
