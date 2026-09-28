'use client';

/**
 * Agent chat states in isolation, from fictional fixtures — no database, no
 * model call. `?state=propose|confirmed|split|question|answered|shipped|streaming|denied|empty|watch|visual`
 * (`&review=1` with `visual` opens the review deck: the sheet on a phone, the pane on desktop)
 * (`&mood=calm|needs` for the empty canvas's mood)
 * and `&aside=member|operator`, `&setup=no_key&admin=1`,
 * `&hints=1` (keyboard hints on), `&controls=1` (the composer's tools menu and
 * tier switch, on fixture rows and prices), `&pane=closed`, `&about=mission` (opened from
 * "Ask about this mission": the mission pinned in the canvas), `&feedback=1` (the thumbs,
 * one turn already voted down), `?steer=1` (steering a running agent).
 * Confirm, Discard and the question options work against the fixture.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import ChatWorkspace from '@/components/chat/ChatWorkspace';
import type { ChatActions } from '@/components/chat/ChatActions';
import { createFixtureVisualReviewTransport } from '@/components/visual-review/fixture-transport';
import type { CanvasPulse } from '@/components/chat/canvas-empty';
import ChatContextPanel from '@/components/chat/ChatContextPanel';
import ChatSetupCard, { type ChatSetupReason } from '@/components/chat/ChatSetupCard';
import { ObjectStoreProvider } from '@/components/chat/objects/ObjectStoreProvider';
import { KeyHintsProvider, keyHintsFromQuery } from '@/components/KeyHints';
import type { ObjectSource } from '@/components/chat/objects/object-store';
import type { ChatMessage, ChatToolPart } from '@/components/chat/chat-contract';
import { isToolPart } from '@/components/chat/chat-contract';
import {
  CHAT_FIXTURE_STATES, ORGANIZER, TEAM_NAME, VIEWER, WORKSPACES, WS, chatFixture, fixtureViews, isChatFixtureState,
  missionRef, questionRef, type ChatFixtureState, VISUAL_FIXTURE_OPTS, VISUAL_FIXTURE_PHASE,
  FIXTURE_TIERS, FIXTURE_TOOL_ROWS, STEER_MESSAGES, STEER_TASK_ID, STEER_WORKER_ID, steerTaskView,
} from './chat-fixtures';
import SteerConversation from '@/components/chat/SteerConversation';
import { TurnFeedbackProvider } from '@/components/chat/TurnFeedback';
import type { ChatTierName } from '@buildd/shared';

/**
 * `&controls=1`: the composer's tools menu and tier switch, served by a
 * stand-in for their two routes (fixture rows and prices, no network). It goes
 * in during the first render, before the controls' effects fetch, and stays for
 * the tab: this is a dev fixture, and restoring on unmount would drop it under
 * Strict Mode's remount while the controls refetch.
 */
const STAND_IN = Symbol.for('buildd.dev-chat.fetch-stand-in');

function installFixtureControls(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get('controls') !== '1' && q.get('steer') !== '1') return false;
  const w = window as typeof window & { [STAND_IN]?: true };
  if (w[STAND_IN]) return true;
  const real = window.fetch.bind(window);
  let rows = FIXTURE_TOOL_ROWS;
  let steered = [...STEER_MESSAGES] as Array<Record<string, unknown>>;
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/chat/tiers')) return json(FIXTURE_TIERS);
    if (url.startsWith(`/api/tasks/${STEER_TASK_ID}/messages`)) return json({ taskId: STEER_TASK_ID, workerId: STEER_WORKER_ID, canSend: true, messages: steered });
    if (url.startsWith(`/api/objects/task/${STEER_TASK_ID}`)) return json(steerTaskView());
    if (url.startsWith(`/api/workers/${STEER_WORKER_ID}/instruct`)) {
      const { message } = JSON.parse(String(init?.body ?? '{}')) as { message?: string };
      steered = [...steered, { type: 'instruction', message, timestamp: Date.now() }];
      return json({ ok: true });
    }
    if (url.startsWith('/api/chat/permissions')) {
      if (init?.method === 'PATCH') {
        const { group, mode } = JSON.parse(String(init.body)) as { group: string; mode: 'ask' | 'allow' };
        rows = rows.map(r => (r.key === group ? { ...r, mode } : r));
      }
      return json({ rows });
    }
    return real(input, init);
  }) as typeof fetch;
  w[STAND_IN] = true;
  return true;
}

function useFixtureControls(): boolean {
  const [on] = useState(installFixtureControls);
  return on;
}

function useParams() {
  const [p, setP] = useState<URLSearchParams | null>(null);
  useEffect(() => { setP(new URLSearchParams(window.location.search)); }, []);
  return p;
}

function approve(messages: ChatMessage[], approvalId: string, approved: boolean): ChatMessage[] {
  return messages.map(m => ({
    ...m,
    parts: m.parts.map(p => {
      if (!isToolPart(p) || p.approval?.id !== approvalId) return p;
      const part: ChatToolPart = approved
        ? { ...p, state: 'output-available', approval: { id: approvalId, approved: true }, output: { summary: 'mission filed, plan-first', data: {}, objects: [missionRef] } }
        : { ...p, state: 'output-denied', approval: { id: approvalId, approved: false } };
      return part;
    }),
  }));
}

export default function DevChatPage() {
  const controls = useFixtureControls();
  const [pinnedTier, setPinnedTier] = useState<ChatTierName | null>(null);
  const params = useParams();
  const raw = params?.get('state');
  const state: ChatFixtureState = isChatFixtureState(raw) ? raw : 'propose';
  const aside = params?.get('aside');
  const setup = params?.get('setup') as ChatSetupReason | null;
  const admin = params?.get('admin') === '1';
  // The empty canvas's mood: `?mood=calm|needs` (none = the summoned canvas, no pulse).
  const moodParam = params?.get('mood');
  const pulse: CanvasPulse | null = moodParam === 'needs'
    ? { needsYou: [{ title: 'Round per line, or only the total?' }], live: 2 }
    : moodParam === 'calm' ? { needsYou: [], live: 0 } : null;

  const fixture = useMemo(() => chatFixture(state), [state]);
  const [messages, setMessages] = useState<ChatMessage[]>(fixture.messages);
  useEffect(() => setMessages(fixture.messages), [fixture]);
  const views = useMemo(() => fixtureViews(state), [state]);
  // Visual review decisions against an in-memory "server" (the S3 fixture
  // transport), so the deck in the sheet or pane is fully clickable and a
  // refetch reads the decisions back.
  const reviewTransport = useMemo(() => createFixtureVisualReviewTransport(VISUAL_FIXTURE_PHASE, VISUAL_FIXTURE_OPTS, { latencyMs: 350 }), []);
  const reviewShots = useCallback<ChatActions['reviewShots']>(({ missionId: _m, ...req }) => reviewTransport.decide(req), [reviewTransport]);
  const undoReview = useCallback<ChatActions['undoReview']>(({ reviewId }) => reviewTransport.undo(reviewId), [reviewTransport]);

  const source: ObjectSource = useMemo(() => ({
    load: async (ref) => {
      const v = views[`${ref.kind}:${ref.id}`];
      if (!v) throw new Error('Not found');
      if (v.kind === 'mission' && v.visual) return { ...v, visual: { ...reviewTransport.model(), missionId: v.id } };
      return v;
    },
  }), [views, reviewTransport]);

  const onApproval = useCallback((id: string, ok: boolean) => {
    setTimeout(() => setMessages(ms => approve(ms, id, ok)), 500);
  }, []);
  const onSend = useCallback((text: string) => {
    setMessages(ms => [...ms, { id: `u-${ms.length}`, role: 'user', metadata: { createdAt: new Date().toISOString(), authorName: VIEWER }, parts: [{ type: 'text', text }] }]);
  }, []);

  if (!params) return null;

  if (params.get('steer') === '1') {
    return (
      <div className="flex h-screen flex-col bg-surface-1" data-fixture-state="steer">
        <SteerConversation taskId={STEER_TASK_ID} onClose={() => {}} />
      </div>
    );
  }

  if (setup === 'no_key') {
    return (
      <div className="min-h-screen bg-surface-1 p-6 md:p-10">
        <div className="mx-auto grid max-w-xl gap-4">
          <ChatSetupCard reason={setup} canManage={admin} />
        </div>
      </div>
    );
  }

  const panel = aside === 'member' || aside === 'operator' ? (
    <ChatContextPanel
      audience={aside}
      needsYou={state === 'question' || state === 'split' ? [{ id: 'q', title: 'Round per line, or only the total?', href: '#', meta: 'checkout · Multi-currency invoices' }] : []}
      missions={[
        { id: 'mission-multi-currency', title: 'Multi-currency invoices', state: 'active', meta: '1/12 · 4 running · filed from chat', tone: 'live' },
        { id: 'mission-usage-pricing', title: 'Usage-based pricing: spec first', state: 'held', meta: 'waiting to be armed', tone: 'attention' },
        { id: 'mission-dark-mode', title: 'Dark mode for the customer portal', state: 'queued', meta: '0/5', tone: 'idle' },
      ]}
      fleet={{ live: 1, capacity: 8 }}
    />
  ) : undefined;

  return (
    <KeyHintsProvider value={keyHintsFromQuery(params)}>
    <div className="h-screen bg-surface-1" data-fixture-state={state}>
      <nav aria-label="Fixture states" className="sr-only">
        {CHAT_FIXTURE_STATES.map(s => <a key={s} href={`?state=${s}`}>{s}</a>)}
      </nav>
      {(() => {
        const workspace = (
          <ObjectStoreProvider key={state} source={source}>
            <ChatWorkspace
              messages={messages}
              status={fixture.status}
              onSend={onSend}
              onApproval={onApproval}
              onStop={() => {}}
              answerQuestion={() => new Promise(r => setTimeout(r, 400))}
              reviewShots={reviewShots}
              undoReview={undoReview}
              initialVisualReview={state === 'visual' && params.get('review') === '1' ? { ref: missionRef, startKey: null } : null}
              title={fixture.title}
              teamName={TEAM_NAME}
              agent={ORGANIZER}
              tier="standard"
              teamId={controls ? 'fixture-team' : null}
              pinnedTier={pinnedTier}
              onTierChange={controls ? setPinnedTier : undefined}
              workspaces={WORKSPACES}
              workspaceId={WS.id}
              onWorkspaceChange={() => {}}
              viewerName={VIEWER}
              aside={panel}
              focusRef={state === 'question' ? questionRef : params.get('about') === 'mission' ? missionRef : null}
              focusOpensSheet={params.get('about') !== 'mission'}
              initialPaneClosed={params.get('pane') === 'closed'}
              pulse={pulse}
            />
          </ObjectStoreProvider>
        );
        if (params.get('feedback') !== '1') return workspace;
        // The thumbs under each settled turn; the first answer already voted down with a reason.
        const ids = messages.filter(m => m.role === 'assistant').map(m => m.id);
        return (
          <TurnFeedbackProvider messageIds={ids} pendingId={fixture.status === 'ready' ? null : ids.at(-1) ?? null} initial={ids[0] ? { [ids[0]]: { signal: 'down', reason: 'too_slow' } } : {}}>
            {workspace}
          </TurnFeedbackProvider>
        );
      })()}
    </div>
    </KeyHintsProvider>
  );
}
