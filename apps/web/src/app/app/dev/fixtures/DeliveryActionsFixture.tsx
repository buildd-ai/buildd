'use client';

/**
 * The delivery states' next moves, which `?state=delivery-states` lists but
 * cannot open (workflow-state-kernel §17.5). Three views, all over the same
 * illustrative deliveries, all display only: every write is answered in
 * memory and nothing leaves the page.
 *
 * - `?state=delivery-review-actions`: Home's review card for an escalated
 *   kernel delivery with a recommendation (Apply, Apply with corrections,
 *   Merge anyway) and with an actionable escalation reason (Dispatch fix).
 * - `?state=delivery-dock`: the chat task tile with its pane open, and the
 *   full dock body for the stalled conflict fix, Run fix included.
 * - `?state=delivery-run-fix`: where Run fix lands, the task page's action
 *   zone for the pending conflict-fix task nobody has claimed.
 */
import { useMemo, useState } from 'react';
import { ActionQueueCard } from '../../(protected)/home/ActionQueueCard';
import TaskActionZone from '../../(protected)/missions/[id]/TaskActionZone';
import { buildActionQueue, type ActionQueueItem } from '@/lib/action-queue';
import ChatDock from '@/components/chat/ChatDock';
import { ChatActionsProvider, DEFAULT_CHAT_ACTIONS, type ChatActions } from '@/components/chat/ChatActions';
import { ObjectStoreProvider } from '@/components/chat/objects/ObjectStoreProvider';
import type { ObjectSource } from '@/components/chat/objects/object-store';
import type { TaskObjectView } from '@/components/chat/objects/object-views';
import type { BuilddObjectRef } from '@/components/chat/chat-contract';
import { TaskCard as ChatTaskTile } from '@/components/chat/objects/TaskObject';
import { CASES, NOW, chatView, listDisplays, raw, views } from './DeliveryStatesFixture';

export const DELIVERY_ACTION_FIXTURE_STATES = ['delivery-review-actions', 'delivery-dock', 'delivery-run-fix'] as const;
export type DeliveryActionFixtureState = (typeof DELIVERY_ACTION_FIXTURE_STATES)[number];

/** The conflict fix the stalled delivery names (DeliveryStatesFixture's remediation). */
export const REMEDIATION_TASK_ID = 'cf-418';
/** The PR the stalled conflict fix repairs. */
const CONFLICT_PR = 418;
const REMEDIATION_TITLE = 'fix(conflict): resolve PR #418 against dev';

/** Every write answers here: an Apply, a Merge, a Run now. Reads pass through. */
function installNoWriteStub() {
  if (typeof window === 'undefined') return;
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, fixture: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real(input, init);
  }) as typeof fetch;
}

/** Home's review card, escalated kernel delivery: with a recommendation, and with a defect to dispatch. */
export function reviewActionItems(): ActionQueueItem[] {
  const queue = buildActionQueue([], CASES.map(raw), { now: NOW, deliveryViews: views });
  const escalated = queue.find(i => i.taskId === 't4' && i.chip === 'REVIEW');
  if (!escalated) return [];
  return [
    { ...escalated, subjectKey: `${escalated.subjectKey}#recommendation`, recommendation: 'Keep the new scope check, and read the workspace from the token rather than the request body.', hasEscalationNote: true },
    { ...escalated, subjectKey: `${escalated.subjectKey}#dispatch`, recommendation: null, hasEscalationNote: true, escalationReason: 'The schema changed without a generated migration; the deploy would fail.' },
  ];
}

const conflict = () => listDisplays.find(x => x.c.key === 'conflict-stalled')!;

/** The pending conflict fix, as the chat object store would load it. */
function remediationView(): TaskObjectView {
  const base = chatView(conflict());
  return {
    ...base, id: REMEDIATION_TASK_ID, title: REMEDIATION_TITLE, scope: 'conflict', label: 'resolve PR #418 against dev',
    status: 'pending', delivery: null, worker: null, attempts: 0, happened: [],
  };
}

function ReviewActions() {
  const items = useMemo(reviewActionItems, []);
  return (
    <section className="space-y-3">
      <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Home · escalated review, recommendation and dispatch</h2>
      {items.map(item => (
        <div key={item.subjectKey} data-testid="delivery-review-action-card" data-chip={item.chip}>
          <ActionQueueCard item={item} />
        </div>
      ))}
    </section>
  );
}

function Dock() {
  const c = conflict();
  const tileView = chatView(c);
  const tileRef: BuilddObjectRef = { kind: 'task', id: c.id, workspaceId: 'fx-ws', fallbackText: c.c.title };
  // Open in pane has been tapped: the tile says so and the dock shows the task.
  const [pane, setPane] = useState<BuilddObjectRef | null>(tileRef);
  const source = useMemo<ObjectSource>(() => {
    const byId = new Map<string, TaskObjectView>([[c.id, tileView], [REMEDIATION_TASK_ID, remediationView()]]);
    return {
      async load(ref) {
        const v = byId.get(ref.id);
        if (!v) throw new Error('Not found');
        return v;
      },
      watch: () => () => {},
    };
  }, [c.id, tileView]);
  const actions: ChatActions = {
    ...DEFAULT_CHAT_ACTIONS,
    openObject: setPane,
    paneRef: pane,
    workspaceName: () => 'acme',
    answerQuestion: async () => {},
    reviewShots: () => Promise.reject(new Error('display only')),
    undoReview: () => Promise.reject(new Error('display only')),
  };
  return (
    <ChatActionsProvider value={actions}>
      <ObjectStoreProvider source={source}>
        <section className="space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Chat · task tile, open in the pane</h2>
          <div data-testid="delivery-dock-tile">
            <ChatTaskTile objRef={tileRef} view={tileView} />
          </div>
          <p className="font-mono text-[12px] text-text-muted lg:hidden">The dock is the desktop panel (1024px and wider); on a phone the tile opens the sheet.</p>
        </section>
        <div className="hidden min-h-[640px] justify-end border border-border-default lg:flex" data-testid="delivery-dock">
          {pane && (
            <ChatDock mode="object" objRef={pane} onClose={() => setPane(null)} onSend={() => {}} onOpen={setPane} />
          )}
        </div>
      </ObjectStoreProvider>
    </ChatActionsProvider>
  );
}

function RunFixLanding() {
  return (
    <section className="space-y-4" data-testid="delivery-run-fix">
      <h2 className="font-mono text-[11px] uppercase tracking-[1.2px] text-text-muted">Task page · where Run fix lands</h2>
      <header className="space-y-1">
        <p className="font-mono text-[12px] text-text-muted">{`Queued · conflict fix for PR #${CONFLICT_PR}`}</p>
        <h1 className="font-mono text-[18px] font-semibold text-text-primary [overflow-wrap:anywhere]">{REMEDIATION_TITLE}</h1>
        <p className="text-body text-text-secondary">The conflict fix has waited 42m with no runner claim.</p>
      </header>
      <TaskActionZone
        taskId={REMEDIATION_TASK_ID}
        workspaceId="fx-ws"
        phase="pending"
        isBlocked={false}
        blockedByCount={0}
        backend="claude"
        lastError={null}
        worker={null}
        roleSlug="builder"
        missionExecutor="runner"
      />
    </section>
  );
}

export default function DeliveryActionsFixture({ state }: { state: DeliveryActionFixtureState }) {
  // Installed before any child effect can fetch.
  useState(installNoWriteStub);
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4" data-testid="delivery-actions-fixture" data-view={state}>
      {state === 'delivery-review-actions' && <div className="max-w-2xl"><ReviewActions /></div>}
      {state === 'delivery-dock' && <Dock />}
      {state === 'delivery-run-fix' && <div className="max-w-2xl"><RunFixLanding /></div>}
    </main>
  );
}
