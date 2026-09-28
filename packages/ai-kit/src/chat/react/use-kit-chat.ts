'use client';

/**
 * `useKitChat`: `useChat` (`@ai-sdk/react`) wired to a `/chat/server` turn
 * endpoint.
 *
 * - Sends only the newest message (`{ message, ...body }`): the server loads
 *   history from its own store and treats the client's copy as an answer.
 * - Approval answers go back automatically once every card in the last
 *   assistant message is answered.
 * - A refusal before any model call (`409 no_key`, `429 budget_exhausted`,
 *   `429 rate_limited`) lands in `unavailable` for `<ChatSetupCard>`, and the
 *   draft is kept.
 * - With `steer`, `steer(text)` posts to the steer endpoint while a turn runs,
 *   and steers the turn ended before applying (`data-steer` `deferred`) are
 *   sent as the next message.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { isSteerPart, type ChatMessage, type ChatUnavailableBody, type ChatUnavailableReason } from '@builddai/ai-kit/chat/contract';

const REASONS = new Set<ChatUnavailableReason>(['no_key', 'budget_exhausted', 'rate_limited']);

export interface UseKitChatOptions {
  /** The turn endpoint (`POST`), e.g. `/api/chat/${conversationId}`. */
  api: string;
  /** The conversation id (`useChat`'s chat id). */
  id?: string;
  initialMessages?: readonly ChatMessage[];
  /** App extras merged into every request body (scope, entry point). */
  body?: Record<string, unknown> | (() => Record<string, unknown>);
  headers?: Record<string, string>;
  /** Default `same-origin`. */
  credentials?: RequestCredentials;
  /** Mid-turn steering: the steer endpoint (`POST { text, id }`). */
  steer?: { api: string };
  onUnavailable?(body: ChatUnavailableBody): void;
  /** Test seam / custom fetch. */
  fetch?: typeof fetch;
}

export interface KitChat {
  messages: ChatMessage[];
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  /** A turn is in flight. */
  busy: boolean;
  error: Error | undefined;
  /** The last refusal, until the next successful send. */
  unavailable: ChatUnavailableBody | null;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  /** Answer an approval card (`<ApprovalCard onRespond>` / `<ChatThread onApprovalResponse>`). */
  respond(approvalId: string, approved: boolean, reason?: string): void;
  /** Steer the running turn. Resolves false when steering is off or the post failed. */
  steer(text: string): Promise<boolean>;
  setMessages(messages: ChatMessage[]): void;
  clearError(): void;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useKitChat(opts: UseKitChatOptions): KitChat {
  const [unavailable, setUnavailable] = useState<ChatUnavailableBody | null>(null);
  const bodyRef = useRef(opts.body);
  bodyRef.current = opts.body;
  const onUnavailableRef = useRef(opts.onUnavailable);
  onUnavailableRef.current = opts.onUnavailable;
  const baseFetch = opts.fetch;

  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: opts.api,
    credentials: opts.credentials ?? 'same-origin',
    headers: opts.headers,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await (baseFetch ?? fetch)(input, init);
      if (!res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
        const body = await res.clone().json().catch(() => null) as ChatUnavailableBody | null;
        if (body && REASONS.has(body.error)) {
          setUnavailable(body);
          onUnavailableRef.current?.(body);
        }
      }
      return res;
    }) as typeof fetch,
    prepareSendMessagesRequest: ({ messages }) => {
      const extra = typeof bodyRef.current === 'function' ? bodyRef.current() : bodyRef.current ?? {};
      return { body: { ...extra, message: messages[messages.length - 1] } };
    },
  }), [opts.api, opts.credentials, opts.headers, baseFetch]);

  const chat = useChat<UIMessage>({
    ...(opts.id ? { id: opts.id } : {}),
    messages: (opts.initialMessages ?? []) as UIMessage[],
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const { messages, sendMessage, status, error, stop, addToolApprovalResponse, setMessages, clearError } = chat;
  const busy = status === 'submitted' || status === 'streaming';

  const send = useCallback(async (text: string) => {
    setUnavailable(null);
    await sendMessage({ text });
  }, [sendMessage]);

  const respond = useCallback((approvalId: string, approved: boolean, reason?: string) => {
    void addToolApprovalResponse({ id: approvalId, approved, ...(reason ? { reason } : {}) });
  }, [addToolApprovalResponse]);

  const steerApi = opts.steer?.api;
  const steer = useCallback(async (text: string) => {
    if (!steerApi || !text.trim()) return false;
    try {
      const res = await (baseFetch ?? fetch)(steerApi, {
        method: 'POST',
        credentials: opts.credentials ?? 'same-origin',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify({ text, id: newId() }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [steerApi, baseFetch, opts.credentials, opts.headers]);

  // Steers the turn ended before applying: send them as the next message, once.
  const sentDeferred = useRef(new Set<string>());
  useEffect(() => {
    if (!steerApi || status !== 'ready') return;
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant') return;
    const pending = (last.parts as ChatMessage['parts']).filter(isSteerPart).filter(p => p.data.state === 'deferred' && !sentDeferred.current.has(p.data.id));
    if (pending.length === 0) return;
    for (const p of pending) sentDeferred.current.add(p.data.id);
    void sendMessage({ text: pending.map(p => p.data.text).join('\n\n') });
  }, [messages, status, steerApi, sendMessage]);

  return {
    messages: messages as unknown as ChatMessage[],
    status,
    busy,
    error,
    unavailable,
    send,
    stop,
    respond,
    steer,
    setMessages: (m: ChatMessage[]) => setMessages(m as unknown as UIMessage[]),
    clearError,
  };
}
