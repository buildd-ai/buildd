/**
 * build-long-open.ts — generate the "long open" demo story.
 *
 *   bun run scripts/demo/stories/build-long-open.ts
 *   → scripts/demo/stories/long-open.json
 *
 * A mission shaped like most small real ones: two tasks, two PRs, about forty
 * minutes of agent work, and five weeks between filing and closing because a
 * PR sat in review. Along the way: two questions escalated to the owner, a
 * friction task whose run was orphaned for days, a few short orchestrator
 * ticks, five records, goal criteria that were never evaluated, and a
 * description that opens with a "prior attempts" preamble.
 *
 * Replay it to just after completion:
 *
 *   bun run scripts/demo/seed.ts scripts/demo/stories/long-open.json
 *   bun run scripts/demo/advance.ts end
 *
 * Everything is fictional: team, people, repo, runners, PR numbers.
 */
import { writeFileSync } from 'fs';

const OUT = new URL('./long-open.json', import.meta.url).pathname;

const M = 60;
const H = 3600;
const D = 86_400;

const REPO = 'https://github.com/tidewater/relay';
const pr = (n: number) => `${REPO}/pull/${n}`;

type Entity = Record<string, unknown>;

const worker = (key: string, taskKey: string, id8: string, runner: string, slug: string): Entity => ({
  key, taskId: taskKey, workspaceId: 'ws', accountId: 'acct_fleet', name: `tidewater-fleet-${id8}`, runner,
  branch: `buildd/${id8}-${slug}`,
});

const task = (key: string, id8: string, fields: Entity): Entity => ({
  key, _idShort: id8, workspaceId: 'ws', missionId: 'M1', outputRequirement: 'pr_required', creationSource: 'mcp', ...fields,
});

const story = {
  _meta: {
    purpose: 'A completed mission with ~40m of agent work that stayed open ~35 days: two tasks, two PRs, two escalations, an orphaned friction run, five records, criteria never evaluated. Fictional throughout.',
    replay: 'seed.ts long-open.json, then advance.ts end',
  },
  team: { key: 'team', name: 'Tidewater', slug: 'tidewater', timezone: 'Europe/Lisbon' },
  users: [{ key: 'u_ines', name: 'Ines Duarte', email: 'ines@tidewater.example' }],
  accounts: [
    { key: 'acct_fleet', type: 'user', level: 'worker', name: 'tidewater-fleet', authType: 'oauth', maxConcurrentWorkers: 4, apiKey: 'bld_demo_long_open_not_a_real_key_000', apiKeyPrefix: 'bld_demo' },
  ],
  runners: [
    { key: 'kite', runner: 'kite', localUiUrl: 'http://kite.local:8766', maxConcurrentWorkers: 2, _display: 'kite · Mac mini' },
    { key: 'gull', runner: 'gull', localUiUrl: 'http://gull.local:8766', maxConcurrentWorkers: 2, _display: 'gull · cloud VM' },
  ],
  workspace: {
    key: 'ws', name: 'relay', repo: REPO, accessMode: 'restricted', configStatus: 'admin_confirmed',
    gitConfig: { defaultBranch: 'main', branchingStrategy: 'trunk', branchStrategy: 'direct', commitStyle: 'conventional', requiresPR: true, targetBranch: 'main', autoCreatePR: true },
    _github: { fullName: 'tidewater/relay' },
  },
  roles: [
    { key: 'organizer', slug: 'organizer', name: 'Organizer', color: '#6366F1', model: 'sonnet', isRole: true, description: 'Plans missions into tasks' },
    { key: 'builder', slug: 'builder', name: 'Builder', color: '#0C72CB', model: 'opus', isRole: true, description: 'Writes code and opens PRs' },
  ],
  missions: [
    {
      key: 'M1', _idShort: '5e0c7a21', workspaceId: 'ws', title: 'Retry failed partner webhooks',
      description: [
        'Prior attempts and why they failed — read before starting:',
        '- A cron replay double-sent invoices: it had no idempotency key.',
        '- Raising the HTTP timeout hid the outage instead of surviving it.',
        '',
        'Retry failed partner webhooks with backoff so a partner outage stops dropping invoices. Park anything still failing after 24 hours for a human to replay from the admin page.',
      ].join('\n'),
      status: 'active', priority: 3, maxConcurrentTasks: 2, defaultOutputRequirement: 'pr_required',
      goalCriteria: [
        { type: 'all_prs_merged', label: 'every task PR merged' },
        { type: 'no_open_tasks', label: 'no open tasks' },
        { type: 'command', command: 'bun test apps/api/webhooks', label: 'webhook suite green' },
        { type: 'description', label: 'a partner outage drops no invoices' },
      ],
    },
  ],
  tasks: [
    task('T0', '5e0c7a30', { title: 'Mission: Retry failed partner webhooks', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', outputRequirement: 'none', creationSource: 'orchestrator', taskClass: 'bookkeeping' }),
    task('T1', '5e0c7a31', {
      title: 'feat(webhooks): retry failed deliveries with backoff', label: 'retry with backoff', roleSlug: 'builder', kind: 'engineering', taskClass: 'work',
      description: 'Queue failed deliveries with an idempotency key and retry on an exponential schedule for up to 24 hours.',
      missionPhaseIndex: 1, missionPhaseLabel: 'Retries',
    }),
    task('T2', '5e0c7a32', {
      title: 'feat(admin): park and replay dead webhooks', label: 'park and replay', roleSlug: 'builder', kind: 'engineering', taskClass: 'work',
      description: 'After 24 hours, park the delivery and list it on the admin page with a Replay button.',
      missionPhaseIndex: 1, missionPhaseLabel: 'Retries', dependsOn: ['T1'],
    }),
    // Filed by T1's agent mid-run. Its worker lost its runner and sat orphaned
    // until the reaper failed it days later.
    task('F1', '5e0c7a40', {
      title: '[friction] no admin API to list parked webhooks', label: 'no admin API', roleSlug: 'builder', kind: 'engineering', taskClass: 'bookkeeping',
      outputRequirement: 'none', description: 'Expected an admin endpoint to list parked deliveries; had to read the table directly.',
    }),
    task('T3', '5e0c7a33', { title: 'Mission: Retry failed partner webhooks', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', outputRequirement: 'none', creationSource: 'orchestrator', taskClass: 'bookkeeping' }),
    task('T4', '5e0c7a34', { title: 'Mission: Retry failed partner webhooks', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', outputRequirement: 'none', creationSource: 'orchestrator', taskClass: 'bookkeeping' }),
  ],
  workers: [
    worker('w0', 'T0', '5e0c7a30', 'kite', 'mission-retry-failed-partner-we'),
    worker('w1', 'T1', '5e0c7a31', 'kite', 'feat-webhooks-retry-failed-deli'),
    worker('wf', 'F1', '5e0c7a40', 'gull', 'friction-no-admin-api-to-list-p'),
    worker('w3', 'T3', '5e0c7a33', 'kite', 'mission-retry-failed-partner-we'),
    worker('w2', 'T2', '5e0c7a32', 'gull', 'feat-admin-park-and-replay-dead'),
    worker('w4', 'T4', '5e0c7a34', 'kite', 'mission-retry-failed-partner-we'),
  ],
  missionNotes: [
    { key: 'n_plan', missionId: 'M1', taskId: 'T0', workerId: 'w0', authorType: 'agent', type: 'decision', title: 'Plan: 2 tasks', body: 'Retries first, then the admin page that parks and replays what never got through.', actorLabel: 'Organizer' },
    { key: 'n_q1', missionId: 'M1', taskId: 'T1', workerId: 'w1', authorType: 'agent', type: 'question', title: 'How long to keep retrying?', body: 'The partner SLA says 4 hours; our invoices are due in 24. Retry for 4 hours or 24?', defaultChoice: '24 hours', actorLabel: 'Builder' },
    { key: 'n_a1', missionId: 'M1', taskId: 'T1', workerId: 'w1', authorType: 'user', type: 'reply', replyTo: 'n_q1', title: '24 hours', body: '24 hours. After that, park it.', actorLabel: 'Ines Duarte' },
    { key: 'n_q2', missionId: 'M1', taskId: 'T2', workerId: 'w2', authorType: 'agent', type: 'question', title: 'Replay one or all?', body: 'Should Replay resend one delivery at a time, or everything parked for that partner?', defaultChoice: 'One at a time', actorLabel: 'Builder' },
    { key: 'n_a2', missionId: 'M1', taskId: 'T2', workerId: 'w2', authorType: 'user', type: 'reply', replyTo: 'n_q2', title: 'One at a time', body: 'One at a time, with a "replay all for partner" link under the list.', actorLabel: 'Ines Duarte' },
  ],
  artifacts: [
    { key: 'a_design', workerId: 'w1', workspaceId: 'ws', missionId: 'M1', type: 'report', artifactKey: 'webhook-retry-design', title: 'Webhook retry design', content: '## Schedule\n1m, 5m, 30m, 2h, then every 4h until 24h.\n\n## Idempotency\nEvery delivery carries `Idempotency-Key: <invoice id>:<event>`; the partner already dedupes on it.', visibility: 'private' },
    { key: 'a_dec1', workerId: 'w1', workspaceId: 'ws', missionId: 'M1', type: 'content', title: 'Decision: retry for 24 hours, then park', content: 'Retry for 24 hours, then park the delivery for a human. _Decided by Ines Duarte._', visibility: 'private' },
    { key: 'a_dryrun', workerId: 'w1', workspaceId: 'ws', missionId: 'M1', type: 'report', title: 'Partner outage dry-run', content: 'Stopped the partner stub for 40 minutes: 312 deliveries queued, all delivered within 6 minutes of it coming back, none duplicated.', visibility: 'private' },
    { key: 'a_dec2', workerId: 'w2', workspaceId: 'ws', missionId: 'M1', type: 'content', title: 'Decision: replay one at a time', content: 'Replay resends one delivery; a "replay all for partner" link sits under the list. _Decided by Ines Duarte._', visibility: 'private' },
    { key: 'a_summary', workerId: 'w4', workspaceId: 'ws', missionId: 'M1', type: 'summary', title: 'Mission summary', content: 'Failed partner webhooks now retry for 24 hours with an idempotency key, then park on the admin page, where each one can be replayed. Both PRs merged.', visibility: 'private' },
  ],
  memories: [],
  timeline: [
    { t: 0, op: 'mission_create', mission: 'M1' },
    // Day 0: plan, then the retry work (with one question to the owner).
    { t: 20, op: 'claim', task: 'T0', worker: 'w0', runner: 'kite' },
    { t: 25, op: 'worker_status', worker: 'w0', status: 'running' },
    { t: 70, op: 'progress', worker: 'w0', pct: 50, message: 'Reading the webhook sender and the invoice events' },
    { t: 170, op: 'task_create', task: 'T1' },
    { t: 170, op: 'task_create', task: 'T2' },
    { t: 172, op: 'mission_note', note: 'n_plan' },
    { t: 180, op: 'complete', task: 'T0', worker: 'w0', summary: 'Planned 2 tasks.' },

    { t: 240, op: 'claim', task: 'T1', worker: 'w1', runner: 'kite' },
    { t: 245, op: 'worker_status', worker: 'w1', status: 'running' },
    { t: 5 * M, op: 'progress', worker: 'w1', pct: 20, message: 'Mapping every call site of sendWebhook' },
    { t: 9 * M, op: 'claim', task: 'F1', worker: 'wf', runner: 'gull' },
    { t: 9 * M + 5, op: 'worker_status', worker: 'wf', status: 'running' },
    { t: 10 * M, op: 'progress', worker: 'w1', pct: 40, message: 'Delivery queue with an idempotency key per invoice event' },
    { t: 12 * M, op: 'waiting_input', worker: 'w1', task: 'T1', note: 'n_q1', waitingFor: { type: 'question', prompt: 'The partner SLA says 4 hours; invoices are due in 24. Retry for 4 hours or 24?', options: ['24 hours', '4 hours'] } },
    { t: 15 * M, op: 'human_reply', worker: 'w1', task: 'T1', note: 'n_a1', message: '24 hours. After that, park it.' },
    { t: 15 * M + 30, op: 'artifact', artifact: 'a_dec1' },
    { t: 17 * M, op: 'artifact', artifact: 'a_design' },
    { t: 19 * M, op: 'progress', worker: 'w1', pct: 80, message: 'Outage dry-run against the partner stub' },
    { t: 21 * M, op: 'artifact', artifact: 'a_dryrun' },
    { t: 22 * M, op: 'pr_open', worker: 'w1', prNumber: 212, prUrl: pr(212), title: 'feat(webhooks): retry failed deliveries with backoff', linesAdded: 348, linesRemoved: 41, filesChanged: 9, commitCount: 3 },
    { t: 23 * M, op: 'complete', task: 'T1', worker: 'w1', summary: 'Deliveries retry for 24 hours with an idempotency key; PR #212.' },
    { t: 30 * M, op: 'ci', worker: 'w1', prNumber: 212, state: 'ci_green' },

    // The friction run lost its runner; the reaper failed it on day 5.
    { t: 5 * D, op: 'worker_status', worker: 'wf', status: 'failed' },

    // Day 12: an orchestrator tick finds nothing to do (PR still in review).
    { t: 12 * D, op: 'claim', task: 'T3', worker: 'w3', runner: 'kite' },
    { t: 12 * D + 5, op: 'worker_status', worker: 'w3', status: 'running' },
    { t: 12 * D + 70, op: 'complete', task: 'T3', worker: 'w3', summary: 'Waiting on PR #212 review; nothing to start.' },

    // Day 33: the PR merges and the second task runs.
    { t: 33 * D, op: 'merge', worker: 'w1', prNumber: 212 },
    { t: 33 * D + 10 * M, op: 'claim', task: 'T2', worker: 'w2', runner: 'gull' },
    { t: 33 * D + 10 * M + 5, op: 'worker_status', worker: 'w2', status: 'running' },
    { t: 33 * D + 14 * M, op: 'progress', worker: 'w2', pct: 30, message: 'Parked deliveries table on the admin page' },
    { t: 33 * D + 16 * M, op: 'waiting_input', worker: 'w2', task: 'T2', note: 'n_q2', waitingFor: { type: 'question', prompt: 'Should Replay resend one delivery at a time, or everything parked for that partner?', options: ['One at a time', 'All for the partner'] } },
    { t: 33 * D + 19 * M, op: 'human_reply', worker: 'w2', task: 'T2', note: 'n_a2', message: 'One at a time, with a "replay all for partner" link under the list.' },
    { t: 33 * D + 19 * M + 30, op: 'artifact', artifact: 'a_dec2' },
    { t: 33 * D + 26 * M, op: 'pr_open', worker: 'w2', prNumber: 219, prUrl: pr(219), title: 'feat(admin): park and replay dead webhooks', linesAdded: 214, linesRemoved: 12, filesChanged: 6, commitCount: 2 },
    { t: 33 * D + 27 * M, op: 'complete', task: 'T2', worker: 'w2', summary: 'Parked deliveries list on the admin page with Replay; PR #219.' },
    { t: 33 * D + 35 * M, op: 'ci', worker: 'w2', prNumber: 219, state: 'ci_green' },
    { t: 34 * D + 2 * H, op: 'merge', worker: 'w2', prNumber: 219 },

    // Day 35: the closing tick writes the summary and completes the mission
    // without evaluating the goal criteria.
    { t: 35 * D, op: 'claim', task: 'T4', worker: 'w4', runner: 'kite' },
    { t: 35 * D + 5, op: 'worker_status', worker: 'w4', status: 'running' },
    { t: 35 * D + 50, op: 'artifact', artifact: 'a_summary' },
    { t: 35 * D + 60, op: 'complete', task: 'T4', worker: 'w4', summary: 'Both PRs merged; closing the mission.' },
    { t: 35 * D + 90, op: 'mission_complete', mission: 'M1' },
  ],
};

writeFileSync(OUT, JSON.stringify(story, null, 2) + '\n');
console.log(`wrote ${OUT}`);
