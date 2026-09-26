/**
 * Chat fixtures for the dev page (/app/dev/chat) and component tests. The
 * fictional Harborline story from scripts/demo/stories/multi-currency.json —
 * no real team, repo, person or id. Ids are readable slugs, never UUIDs.
 */
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput } from '@/lib/mission-board';
import type { BuilddObjectRef, ChatMessage, ChatToolPart } from '@/components/chat/chat-contract';
import type { MissionObjectView, ObjectView, PrObjectView, QuestionObjectView, TaskObjectView } from '@/components/chat/objects/object-views';

/**
 * The story's clock. Anchored 16 minutes before "now" (to the minute) so the
 * Board's live ages read as they do mid-story; tests pass their own `now`.
 */
export const FIXTURE_T0 = Math.floor(Date.now() / 60_000) * 60_000 - 16 * 60_000;
const at = (min: number) => FIXTURE_T0 + min * 60_000;
const iso = (min: number) => new Date(at(min)).toISOString();

export const WS = { id: 'ws-billing-web', name: 'billing-web' } as const;
export const WORKSPACES = [WS, { id: 'ws-marketing-site', name: 'marketing-site' }];
export const ORGANIZER = { name: 'Organizer', color: '#6366F1' };
export const TEAM_NAME = 'Harborline';
export const VIEWER = 'Maya';

export const MISSION_ID = 'mission-multi-currency';
export const QUESTION_TASK_ID = 'task-checkout';

// ── The mission, as the board sees it ────────────────────────────────────────

const ROLES = [
  { slug: 'organizer', name: 'Organizer', color: '#6366F1' },
  { slug: 'builder', name: 'Builder', color: '#0C72CB' },
  { slug: 'researcher', name: 'Researcher', color: '#B24C9C' },
  { slug: 'writer', name: 'Writer', color: '#0EA5E9' },
];
const CRITERIA = [
  { type: 'all_prs_merged', label: 'every task PR merged' },
  { type: 'no_open_tasks', label: 'no open tasks' },
  { type: 'command', label: 'currency suite green' },
  { type: 'artifact_exists', key: 'fx-rounding-decision', label: 'rounding policy recorded' },
];

type Moment = 'filed' | 'live' | 'question';

let wseq = 0;
function worker(over: Partial<BoardWorkerInput>): BoardWorkerInput {
  wseq += 1;
  return {
    id: `w-${wseq}`, status: 'running', runner: 'atlas', startedAt: at(5), completedAt: null, updatedAt: at(6),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}
const pr = (n: number) => `https://github.com/harborline/billing-web/pull/${n}`;

function task(id: string, title: string, phase: 1 | 2 | 3, role: string, workers: BoardWorkerInput[], over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  const w = workers[0];
  const labels = { 1: 'Foundations', 2: 'Through the product', 3: 'Prove it' } as const;
  return {
    id, title, status: 'pending', taskClass: 'work', createdAt: new Date(at(4)), missionPhaseIndex: phase,
    missionPhaseLabel: labels[phase], roleSlug: role, outputRequirement: role === 'researcher' ? null : 'pr_required', workers,
    worker: w ? {
      status: w.status, startedAt: w.startedAt ? new Date(w.startedAt) : null, updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
      prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: w.mergedAt ? new Date(w.mergedAt) : null,
    } : null,
    ...over,
  };
}

const merged = (runner: string, n: number, start: number, end: number, add: number, rem: number) =>
  worker({ status: 'completed', runner, startedAt: at(start), completedAt: at(end), updatedAt: at(end), mergedAt: at(end + 1), prNumber: n, prUrl: pr(n), prLifecycleStatus: 'merged', linesAdded: add, linesRemoved: rem });
const running = (runner: string, start: number, action: string, extra: Partial<BoardWorkerInput> = {}) =>
  worker({ runner, startedAt: at(start), updatedAt: at(start + 6), currentAction: action, milestones: [{ ts: at(start + 2), label: 'Read the code' }, { ts: at(start + 5), label: action }], ...extra });

export function missionBoardFixture(moment: Moment) {
  wseq = 0;
  const filed = moment === 'filed';
  const now = filed ? at(9) : at(16);
  const tasks: BoardTaskInput[] = [
    task('task-fx-providers', 'RESEARCH: FX rate providers', 1, 'researcher', [running('birch', 5, 'Comparing rate freshness')], { status: 'in_progress' }),
    task('task-db', 'feat(db): currency columns', 1, 'builder',
      filed ? [running('atlas', 5, 'Writing the migration')] : [merged('atlas', 411, 5, 11, 186, 4)], { status: filed ? 'in_progress' : 'completed' }),
    task('task-money', 'refactor(money): formatMoney', 1, 'builder',
      filed ? [running('cedar', 5, 'Replacing toFixed(2)')] : [merged('cedar', 412, 5, 12, 148, 96)], { status: filed ? 'in_progress' : 'completed' }),
    task('task-fx', 'feat(fx): rates service', 1, 'builder',
      filed ? [] : [merged('atlas', 413, 11, 15, 301, 0)], { status: filed ? 'pending' : 'completed', dependsOn: filed ? ['task-db'] : [] }),
    task('task-settings', 'feat(settings): currency picker', 1, 'builder', [running('dune', 6, 'Adding the settings field')], { status: 'in_progress' }),
    ...(filed ? [] : [
      task('task-api', 'feat(api): currency on API', 2, 'builder',
        [running('birch', 12, 'Waiting on CI', { prNumber: 415, prUrl: pr(415), prLifecycleStatus: 'ci_pending' })], { status: 'in_progress', dependsOn: ['task-db'] }),
      task('task-invoices', 'feat(invoices): render in currency', 2, 'builder', [running('cedar', 13, 'Rendering the footnote')], { status: 'in_progress', dependsOn: ['task-db', 'task-money'] }),
      task(QUESTION_TASK_ID, 'feat(checkout): Stripe in currency', 2, 'builder', [
        moment === 'question'
          ? worker({ status: 'waiting_input', runner: 'dune', startedAt: at(13), updatedAt: at(15), waitingFor: { prompt: 'Round per line, or only the total?', options: ['Per line: match Stripe', 'Total only: match the ledger'] } })
          : running('dune', 13, 'Wiring the presentment currency'),
      ], { status: 'in_progress', dependsOn: ['task-db', 'task-fx'] }),
      task('task-export', 'feat(export): dual-currency CSV', 2, 'builder', [running('atlas', 14, 'Adding the rate column')], { status: 'in_progress', dependsOn: ['task-db'] }),
      task('task-email', 'feat(email): receipt currency', 2, 'builder', [], { dependsOn: ['task-invoices'] }),
      task('task-e2e', 'test(e2e): pay a EUR invoice', 3, 'builder', [], { dependsOn: ['task-invoices', QUESTION_TASK_ID] }),
      task('task-guide', 'docs: admin guide', 3, 'writer', [], { dependsOn: ['task-invoices', QUESTION_TASK_ID] }),
    ]),
  ];
  return buildMissionBoard({
    tasks, roles: ROLES, now, missionCreatedAt: FIXTURE_T0, missionStatus: 'active', criteria: CRITERIA,
    fleetCapacity: 8,
  });
}

export function missionView(moment: Moment): MissionObjectView {
  const board = missionBoardFixture(moment);
  return {
    kind: 'mission', id: MISSION_ID, workspaceId: WS.id, title: 'Multi-currency invoices',
    goal: 'Let customers see, pay, and get receipts for invoices in their own currency.',
    status: 'active', stateLabel: moment === 'question' ? 'Needs you' : 'Running', workspaceName: WS.name,
    conversationId: 'conv-multi-currency', board, renderedAt: board.now,
  };
}

export const questionView = (open = true): QuestionObjectView => ({
  kind: 'question', id: QUESTION_TASK_ID, workspaceId: WS.id, open, workerId: 'w-checkout', taskId: QUESTION_TASK_ID,
  taskTitle: 'feat(checkout): Stripe in currency', scope: 'checkout', missionId: MISSION_ID,
  askerLabel: 'The builder asks', askedAt: at(15), renderedAt: at(16),
  question: {
    headline: 'Round per line, or only the total?',
    body: 'Rounding each converted line to cents can differ from rounding the total by up to one minor unit per line. Which one is the source of truth?',
    options: [
      { label: 'Per line: match Stripe', description: 'The total equals what Stripe charges the card.', recommended: true },
      { label: 'Total only: match the ledger', description: 'Matches the base-currency books. The card charge can be off by a cent.', recommended: false },
    ],
    noteId: null,
  },
  answer: open ? null : 'Per line: match Stripe',
});

export const taskView = (): TaskObjectView => ({
  kind: 'task', id: 'task-fx', workspaceId: WS.id, title: 'feat(fx): rates service with a 15-minute cache', scope: 'fx', label: 'rates service',
  status: 'completed', roleName: 'Builder', roleColor: '#0C72CB', missionId: MISSION_ID, missionTitle: 'Multi-currency invoices',
  worker: { id: 'w-fx', status: 'completed', runner: 'atlas', startedAt: at(11), completedAt: at(15), currentAction: null, waiting: false, prNumber: 413, prUrl: pr(413), mergedAt: at(16), prLifecycleStatus: 'merged' },
  now: null, renderedAt: at(16),
});

const SHIPPED: Array<[number, string, number, number]> = [
  [411, 'currency columns', 212, 4],
  [412, 'formatMoney', 148, 96],
  [413, 'rates service', 301, 0],
  [415, 'currency on API', 164, 8],
  [416, 'render in currency', 233, 41],
  [417, 'currency picker', 97, 12],
  [410, 'bump stripe-node · deps', 3, 3],
];
export const prView = ([n, title, add, rem]: [number, string, number, number]): PrObjectView => ({
  kind: 'pr', id: `harborline/billing-web#${n}`, workspaceId: WS.id, number: n, url: pr(n), title, state: 'merged',
  linesAdded: add, linesRemoved: rem, mergedAt: at(200), taskId: null, missionId: n === 410 ? null : MISSION_ID, renderedAt: at(220),
});

// ── Refs ─────────────────────────────────────────────────────────────────────

export const missionRef: BuilddObjectRef = { kind: 'mission', id: MISSION_ID, workspaceId: WS.id, fallbackText: 'Mission: Multi-currency invoices' };
export const questionRef: BuilddObjectRef = { kind: 'question', id: 'w-checkout', taskId: QUESTION_TASK_ID, missionId: MISSION_ID, workspaceId: WS.id, fallbackText: 'The checkout Builder asks: Round per line, or only the total?' };
export const taskRef: BuilddObjectRef = { kind: 'task', id: 'task-fx', workspaceId: WS.id, fallbackText: 'Task: rates service' };
export const prRefs: BuilddObjectRef[] = SHIPPED.map(([n, title]) => ({
  kind: 'pr', id: `harborline/billing-web#${n}`, repo: 'harborline/billing-web', prNumber: n, url: pr(n), workspaceId: WS.id, fallbackText: `#${n} ${title}`,
}));

// ── Messages ─────────────────────────────────────────────────────────────────

let pseq = 0;
function call(name: string, input: Record<string, unknown>, output: unknown, over: Partial<ChatToolPart> = {}): ChatToolPart {
  pseq += 1;
  return { type: `tool-${name}`, toolCallId: `call-${pseq}`, state: 'output-available', input, output, ...over };
}
const user = (id: string, text: string, min: number): ChatMessage => ({ id, role: 'user', metadata: { createdAt: iso(min), authorName: VIEWER }, parts: [{ type: 'text', text }] });
const agent = (id: string, min: number, parts: ChatMessage['parts'], durationMs?: number): ChatMessage => ({ id, role: 'assistant', metadata: { createdAt: iso(min), durationMs }, parts });

const MISSION_DRAFT = {
  action: 'create',
  workspaceId: WS.id,
  title: 'Multi-currency invoices',
  description: 'Let customers see, pay, and get receipts for invoices in their own currency.\n\nConstraints:\n- Invoices API changes are additive (v2-safe). FX rate is snapshotted at issue.',
  goalCriteria: [
    { type: 'all_prs_merged', label: 'every task PR merged' },
    { type: 'no_open_tasks', label: 'no open tasks' },
    { type: 'command', command: 'pnpm test --filter @harborline/money --filter web -- currency', label: 'currency suite green' },
    { type: 'artifact_exists', key: 'fx-rounding-decision', label: 'rounding policy recorded' },
  ],
};

function explore(): ChatMessage[] {
  return [
    user('m1', 'What would it take to bill customers in their own currency?', 1),
    agent('m2', 1, [
      { type: 'step-start' },
      call('manage_missions', { action: 'list', workspace: 'billing-web' }, { summary: '3 open, none touch currency', data: [], objects: [] }),
      call('recall', { query: 'currency money rounding' }, { summary: '1 recalled: money is integer minor units', data: [], objects: [] }),
      call('list_tasks', { workspace: 'billing-web', status: 'in_progress' }, { summary: 'nothing in flight touches currency', data: [], objects: [] }),
      { type: 'text', text: 'Nothing in flight touches currency. Amounts are integer cents in one base currency, so this reaches six surfaces: the invoice schema, an FX rates service, a currency picker, invoice rendering, Stripe checkout and the accounting export. The public Invoices API needs a currency field too, added without breaking v2 clients.' },
    ], 2400),
    user('m3', 'Make it a mission. Keep the public API backward compatible.', 3),
  ];
}

export type ChatFixtureState = 'empty' | 'streaming' | 'propose' | 'confirmed' | 'split' | 'question' | 'answered' | 'shipped' | 'denied';
export const CHAT_FIXTURE_STATES: ChatFixtureState[] = ['empty', 'streaming', 'propose', 'confirmed', 'split', 'question', 'answered', 'shipped', 'denied'];

export function isChatFixtureState(v: string | null | undefined): v is ChatFixtureState {
  return !!v && (CHAT_FIXTURE_STATES as string[]).includes(v);
}

export function chatFixture(state: ChatFixtureState): { messages: ChatMessage[]; title: string | null; status: 'ready' | 'streaming' | 'submitted' } {
  pseq = 0;
  switch (state) {
    case 'empty':
      return { messages: [], title: null, status: 'ready' };
    case 'streaming':
      return {
        title: null, status: 'streaming',
        messages: [
          user('m1', 'What would it take to bill customers in their own currency?', 1),
          agent('m2', 1, [
            call('manage_missions', { action: 'list', workspace: 'billing-web' }, { summary: '3 open, none touch currency', data: [], objects: [] }),
            call('recall', { query: 'currency money rounding' }, undefined, { state: 'input-available' }),
            { type: 'text', text: 'Nothing in flight touches currency. Amounts are integer', state: 'streaming' },
          ]),
        ],
      };
    case 'propose':
    case 'denied': {
      const denied = state === 'denied';
      return {
        title: 'Multi-currency invoices', status: 'ready',
        messages: [...explore(), agent('m4', 3, [
          { type: 'text', text: 'Here’s a draft. I won’t file it until you confirm.' },
          call('manage_missions', MISSION_DRAFT, undefined, denied
            ? { state: 'output-denied', approval: { id: 'approval-1', approved: false, reason: 'Discarded by the user' } }
            : { state: 'approval-requested', approval: { id: 'approval-1' } }),
        ], 2400)],
      };
    }
    case 'confirmed':
      return {
        title: 'Multi-currency invoices', status: 'ready',
        messages: [...explore(), agent('m4', 4, [
          { type: 'text', text: 'Here’s a draft. I won’t file it until you confirm.' },
          call('manage_missions', MISSION_DRAFT, { summary: 'mission filed, plan-first', data: { id: MISSION_ID }, objects: [missionRef] }, { approval: { id: 'approval-1', approved: true } }),
          { type: 'text', text: 'Filed. The Organizer is planning it now; the card fills in as agents pick up tasks.' },
        ], 2400)],
      };
    case 'split':
    case 'question':
    case 'answered':
      return {
        title: 'Multi-currency invoices', status: 'ready',
        messages: [
          user('m3', 'Make it a mission. Keep the public API backward compatible.', 3),
          agent('m4', 4, [
            call('manage_missions', MISSION_DRAFT, { summary: 'filed', data: { id: MISSION_ID }, objects: [missionRef] }, { approval: { id: 'approval-1', approved: true } }),
          ]),
          agent('m5', 12, [
            call('get_task', { task: 'rates service' }, { summary: '#413 merged, CI green', data: {}, objects: [] }),
            { type: 'text', text: 'Three are in: currency columns, formatMoney and the rates service. The pane updates as they land.' },
          ]),
          agent('m6', 16, [
            call('get_task', { task: 'checkout' }, { summary: 'waiting on you', data: {}, objects: [questionRef] }),
            { type: 'text', text: 'The checkout Builder needs a call from you. Everything else keeps going.' },
          ]),
        ],
      };
    case 'shipped':
      return {
        title: 'What shipped today', status: 'ready',
        messages: [
          user('s1', 'what did my agents ship today?', 220),
          agent('s2', 220, [
            call('list_tasks', { status: 'completed', since: 'today' }, { summary: '7 PRs across 2 missions', data: [], objects: prRefs }),
            { type: 'text', text: 'Seven PRs merged today. Multi-currency is 9 of 12 done, and checkout is in CI.' },
          ], 1900),
        ],
      };
  }
}

/** Every view the fixture refs resolve to, keyed by the ref (`kind:id`), for the memory object source. */
export function fixtureViews(state: ChatFixtureState): Record<string, ObjectView> {
  const moment: Moment = state === 'confirmed' ? 'filed' : state === 'question' || state === 'split' ? 'question' : 'live';
  const pairs: Array<[BuilddObjectRef, ObjectView]> = [
    [missionRef, missionView(moment)],
    [questionRef, questionView(state !== 'answered')],
    [taskRef, taskView()],
    ...prRefs.map((r, i): [BuilddObjectRef, ObjectView] => [r, prView(SHIPPED[i])]),
  ];
  return Object.fromEntries(pairs.map(([r, v]) => [`${r.kind}:${r.id}`, v]));
}
