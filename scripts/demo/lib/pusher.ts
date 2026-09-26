/**
 * Minimal Pusher REST trigger for the local soketi container. Signs requests
 * the same way the `pusher` npm package does, so no extra dependency is needed.
 * Best-effort: if soketi is down, the storyboard falls back to page reloads.
 */
import { createHash, createHmac } from 'crypto';
import { DEMO } from './guard';

export async function triggerPusher(channel: string, event: string, data: unknown): Promise<boolean> {
  const { appId, key, secret } = DEMO.pusher;
  const body = JSON.stringify({ name: event, channels: [channel], data: JSON.stringify(data) });
  const path = `/apps/${appId}/events`;
  const params: Record<string, string> = {
    auth_key: key,
    auth_timestamp: String(Math.floor(Date.now() / 1000)),
    auth_version: '1.0',
    body_md5: createHash('md5').update(body).digest('hex'),
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = createHmac('sha256', secret).update(`POST\n${path}\n${query}`).digest('hex');
  try {
    const res = await fetch(`${DEMO.soketiUrl}${path}?${query}&auth_signature=${signature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}
