'use client';

/**
 * Agent chat states in isolation, from fictional fixtures — no database, no
 * model call. `?state=propose|confirmed|split|question|answered|shipped|streaming|denied|empty`
 * and `&aside=member|operator`, `&setup=no_key|capability_disabled&admin=1`.
 * Confirm, Discard and the question options work against the fixture.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import ChatWorkspace from '@/components/chat/ChatWorkspace';
import ChatContextPanel from '@/components/chat/ChatContextPanel';
import ChatSetupCard, { type ChatSetupReason } from '@/components/chat/ChatSetupCard';
import { ObjectStoreProvider } from '@/components/chat/objects/ObjectStoreProvider';
import type { ObjectSource } from '@/components/chat/objects/object-store';
import type { ChatMessage, ChatToolPart } from '@/components/chat/chat-contract';
import { isToolPart } from '@/components/chat/chat-contract';
import {
  CHAT_FIXTURE_STATES, ORGANIZER, TEAM_NAME, VIEWER, WORKSPACES, WS, chatFixture, fixtureViews, isChatFixtureState,
  missionRef, questionRef, type ChatFixtureState,
} from './chat-fixtures';

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
  const params = useParams();
  const raw = params?.get('state');
  const state: ChatFixtureState = isChatFixtureState(raw) ? raw : 'propose';
  const aside = params?.get('aside');
  const setup = params?.get('setup') as ChatSetupReason | null;
  const admin = params?.get('admin') === '1';

  const fixture = useMemo(() => chatFixture(state), [state]);
  const [messages, setMessages] = useState<ChatMessage[]>(fixture.messages);
  useEffect(() => setMessages(fixture.messages), [fixture]);
  const views = useMemo(() => fixtureViews(state), [state]);
  const source: ObjectSource = useMemo(() => ({
    load: async (ref) => {
      const v = views[`${ref.kind}:${ref.id}`];
      if (!v) throw new Error('Not found');
      return v;
    },
  }), [views]);

  const onApproval = useCallback((id: string, ok: boolean) => {
    setTimeout(() => setMessages(ms => approve(ms, id, ok)), 500);
  }, []);
  const onSend = useCallback((text: string) => {
    setMessages(ms => [...ms, { id: `u-${ms.length}`, role: 'user', metadata: { createdAt: new Date().toISOString(), authorName: VIEWER }, parts: [{ type: 'text', text }] }]);
  }, []);

  if (!params) return null;

  if (setup === 'no_key' || setup === 'capability_disabled') {
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
    <div className="h-screen bg-surface-1" data-fixture-state={state}>
      <nav aria-label="Fixture states" className="sr-only">
        {CHAT_FIXTURE_STATES.map(s => <a key={s} href={`?state=${s}`}>{s}</a>)}
      </nav>
      <ObjectStoreProvider key={state} source={source}>
        <ChatWorkspace
          messages={messages}
          status={fixture.status}
          onSend={onSend}
          onApproval={onApproval}
          answerQuestion={() => new Promise(r => setTimeout(r, 400))}
          title={fixture.title}
          teamName={TEAM_NAME}
          agent={ORGANIZER}
          tier="standard"
          workspaces={WORKSPACES}
          workspaceId={WS.id}
          onWorkspaceChange={() => {}}
          viewerName={VIEWER}
          aside={panel}
          focusRef={state === 'question' ? questionRef : null}
          initialPaneClosed={params.get('pane') === 'closed'}
        />
      </ObjectStoreProvider>
    </div>
  );
}
