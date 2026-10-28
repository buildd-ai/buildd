// @ui-copy
import { startAuthentication } from '@simplewebauthn/browser';

/**
 * The browser half of the presence check (Living Spec b7fc9316 R-20). `send`
 * makes the guarded request, with `presence` when it has one. When the server
 * answers `presence_required`, this asks the server for a challenge over the
 * pin it named, runs the person's passkey prompt, and sends again with the
 * assertion. Anything else, including `passkey_missing`, comes back as it was.
 * `onAsk` runs just before the prompt, so the page can say it is waiting on it.
 *
 * The browser never decides what a passkey is for: it hands back the pin the
 * server sent, and the server checks the assertion against what it is about
 * to write.
 */
export interface PasskeyReply {
  res: Response | null;
  body: { error?: string; code?: string; presence?: { addUrl?: string } } & Record<string, unknown>;
}

const readBody = async (res: Response | null): Promise<PasskeyReply['body']> => ((await res?.json().catch(() => ({}))) ?? {}) as PasskeyReply['body'];

export async function withPasskey(send: (presence?: unknown) => Promise<Response | null>, opts: { onAsk?: () => void } = {}): Promise<PasskeyReply> {
  const first = await send().catch(() => null);
  const body = await readBody(first);
  const pin = (body.presence as { pin?: unknown } | undefined)?.pin;
  if (first?.status !== 403 || body.code !== 'presence_required' || !pin) return { res: first, body };
  opts.onAsk?.();

  const asked = await fetch('/api/passkeys/presence', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  }).catch(() => null);
  const options = await readBody(asked);
  if (!asked?.ok) return { res: asked, body: options };

  let assertion: unknown;
  try {
    assertion = await startAuthentication({ optionsJSON: options.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
  } catch {
    return { res: null, body: { error: 'Passkey check cancelled. Nothing changed.', code: 'presence_cancelled' } };
  }
  const second = await send(assertion).catch(() => null);
  return { res: second, body: await readBody(second) };
}

/** A reply that means the person has to add a passkey first. */
export const needsPasskey = (body: PasskeyReply['body']) => body.code === 'passkey_missing';
