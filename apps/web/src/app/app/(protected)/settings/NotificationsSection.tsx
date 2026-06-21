'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Props {
  workspaces: Workspace[];
  currentTeamId: string | null;
}

type NotifyEvent = 'taskClaimed' | 'taskCompleted' | 'taskFailed' | 'credentialExpired';

interface NotificationsState {
  channels: { pushover: boolean; webhook: boolean };
  preferences: Record<NotifyEvent, boolean>;
}

const EVENT_LABELS: { key: NotifyEvent; label: string; hint: string }[] = [
  { key: 'taskClaimed', label: 'Task claimed', hint: 'A worker picked up a task.' },
  { key: 'taskCompleted', label: 'Task completed', hint: 'A task finished successfully.' },
  { key: 'taskFailed', label: 'Task failed', hint: 'A task failed (or is auto-retrying).' },
  { key: 'credentialExpired', label: 'Credential expired', hint: 'A Claude/Codex credential is invalid or expired.' },
];

/**
 * Per-team notification settings. Alerts route to THIS team's own channel — a
 * Pushover user/group key (buildd sends via its own app token) and/or a webhook
 * URL — and each event type can be toggled. Teams with no channel get nothing.
 * Mirrors the AgentBackendsSection team selector conventions.
 */
export default function NotificationsSection({ workspaces, currentTeamId }: Props) {
  const teamWorkspaces = useMemo(
    () => (currentTeamId ? workspaces.filter((w) => w.teamId === currentTeamId) : workspaces),
    [workspaces, currentTeamId],
  );
  const teamId = currentTeamId ?? teamWorkspaces[0]?.teamId ?? '';

  const [state, setState] = useState<NotificationsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pushoverKey, setPushoverKey] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/notifications`);
      if (res.ok) setState((await res.json()) as NotificationsState);
    } catch {
      setMsg({ type: 'error', text: 'Failed to load notification settings' });
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    setPushoverKey('');
    setWebhookUrl('');
    void load();
  }, [load]);

  async function put(body: Record<string, unknown>, successText: string) {
    if (!teamId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setState(data as NotificationsState);
      setMsg({ type: 'success', text: successText });
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setBusy(false);
    }
  }

  async function saveChannels() {
    const body: Record<string, unknown> = {};
    if (pushoverKey.trim()) body.pushoverUserKey = pushoverKey.trim();
    if (webhookUrl.trim()) body.webhookUrl = webhookUrl.trim();
    if (Object.keys(body).length === 0) return;
    await put(body, 'Channel saved.');
    setPushoverKey('');
    setWebhookUrl('');
  }

  async function clearChannel(which: 'pushover' | 'webhook') {
    await put(which === 'pushover' ? { pushoverUserKey: null } : { webhookUrl: null }, 'Channel removed.');
  }

  async function toggle(event: NotifyEvent, value: boolean) {
    if (!state) return;
    // Optimistic
    setState({ ...state, preferences: { ...state.preferences, [event]: value } });
    await put({ preferences: { [event]: value } }, 'Preferences updated.');
  }

  if (teamWorkspaces.length === 0 || !teamId) return null;

  const hasPushover = state?.channels.pushover ?? false;
  const hasWebhook = state?.channels.webhook ?? false;

  return (
    <section>
      <div className="flex items-end justify-between mb-3 gap-3">
        <h2 className="section-label">Notifications</h2>
      </div>

      <div className="card p-4 space-y-5">
        <p className="text-sm text-text-secondary">
          Route alerts to <strong className="text-text-primary">this team&apos;s</strong> own channel. Set a Pushover
          user/group key and/or a webhook URL, then choose which events fire. Teams with no channel configured receive nothing.
        </p>

        {loading ? (
          <div className="text-sm text-text-tertiary">Loading…</div>
        ) : (
          <>
            {/* Channels */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">Channels</h3>

              <div className="space-y-2">
                <label className="text-xs font-medium text-text-secondary">Pushover user/group key</label>
                <div className="flex items-center gap-2">
                  {hasPushover && (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-success" /> Configured
                    </span>
                  )}
                  {hasPushover && (
                    <button onClick={() => clearChannel('pushover')} disabled={busy} className="text-xs text-status-error font-medium disabled:opacity-50">
                      Remove
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  value={pushoverKey}
                  onChange={(e) => setPushoverKey(e.target.value)}
                  placeholder={hasPushover ? 'Replace key…' : 'u… (Pushover user or group key)'}
                  className="w-full h-11 px-3 rounded-lg border bg-surface font-mono text-xs"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-text-secondary">Webhook URL</label>
                <div className="flex items-center gap-2">
                  {hasWebhook && (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-success" /> Configured
                    </span>
                  )}
                  {hasWebhook && (
                    <button onClick={() => clearChannel('webhook')} disabled={busy} className="text-xs text-status-error font-medium disabled:opacity-50">
                      Remove
                    </button>
                  )}
                </div>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder={hasWebhook ? 'Replace URL…' : 'https://example.com/buildd-alerts'}
                  className="w-full h-11 px-3 rounded-lg border bg-surface font-mono text-xs"
                />
              </div>

              <button
                onClick={saveChannels}
                disabled={busy || (!pushoverKey.trim() && !webhookUrl.trim())}
                className="h-9 px-4 rounded-lg bg-status-info text-white text-sm font-medium disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save channel'}
              </button>
            </div>

            <div className="border-t border-border-default" />

            {/* Event toggles */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">Events</h3>
              <div className="space-y-2">
                {EVENT_LABELS.map(({ key, label, hint }) => (
                  <label key={key} className="flex items-start justify-between gap-3 bg-surface-3/50 rounded-lg px-3 py-2 cursor-pointer">
                    <div className="min-w-0">
                      <div className="text-sm text-text-primary">{label}</div>
                      <div className="text-xs text-text-muted">{hint}</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={state?.preferences[key] ?? true}
                      disabled={busy}
                      onChange={(e) => toggle(key, e.target.checked)}
                      className="mt-1 h-4 w-4 flex-shrink-0"
                    />
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {msg && (
          <div className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</div>
        )}
      </div>
    </section>
  );
}
