'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Section from '@/components/ui/Section';
import Lede from '@/components/ui/Lede';
import ChannelRow from './notifications/ChannelRow';

interface Workspace {
  id: string;
  name: string;
  teamId: string;
}

interface Props {
  workspaces: Workspace[];
  currentTeamId: string | null;
  /**
   * Holds `manage_team_notifications` in the team (overrides applied). False:
   * which channels are set and which events fire, read-only. Defaults to true.
   */
  canManage?: boolean;
}

type NotifyEvent = 'taskClaimed' | 'taskCompleted' | 'taskFailed' | 'credentialExpired';

interface NotificationsState {
  channels: { pushover: boolean; webhook: boolean };
  preferences: Record<NotifyEvent, boolean>;
}

const EVENT_LABELS: { key: NotifyEvent; label: string; hint: string }[] = [
  { key: 'taskClaimed', label: 'Task claimed', hint: 'A worker picked up a task.' },
  { key: 'taskCompleted', label: 'Task completed', hint: 'A task finished.' },
  { key: 'taskFailed', label: 'Task failed', hint: 'A task failed or is retrying.' },
  { key: 'credentialExpired', label: 'Credential expired', hint: 'A Claude/Codex credential is invalid or expired.' },
];

/**
 * Settings › Team › Alerts. One Channels list (the team's Pushover app, the
 * team's webhook) as L1 rows with one state vocabulary, then "Team alerts":
 * which events reach the team's channels. Team alerts route to THIS team's own
 * channel; teams with no channel get nothing. Without `canManage` everything
 * reads as values, with no controls; the page says who manages it.
 */
export default function NotificationsSection({ workspaces, currentTeamId, canManage = true }: Props) {
  const teamWorkspaces = useMemo(
    () => (currentTeamId ? workspaces.filter((w) => w.teamId === currentTeamId) : workspaces),
    [workspaces, currentTeamId],
  );
  const teamId = currentTeamId ?? teamWorkspaces[0]?.teamId ?? '';

  const [state, setState] = useState<NotificationsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pushoverKey, setPushoverKey] = useState('');
  const [pushoverAppToken, setPushoverAppToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<null | 'pushover' | 'webhook'>(null);

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
    setPushoverAppToken('');
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

  async function saveChannel(which: 'pushover' | 'webhook') {
    const body: Record<string, unknown> = {};
    if (which === 'pushover') {
      const appToken = pushoverAppToken.trim();
      const userKey = pushoverKey.trim();
      // Pushover needs BOTH; guard here so we don't send a half-set channel.
      if (!appToken || !userKey) {
        setMsg({ type: 'error', text: 'Pushover needs both an app token and a user or group key.' });
        return;
      }
      body.pushoverAppToken = appToken;
      body.pushoverUserKey = userKey;
    } else {
      if (!webhookUrl.trim()) return;
      body.webhookUrl = webhookUrl.trim();
    }
    await put(body, 'Channel saved.');
    setPushoverKey('');
    setPushoverAppToken('');
    setWebhookUrl('');
    setEditing(null);
  }

  function cancelEdit() {
    setEditing(null);
    setPushoverKey('');
    setPushoverAppToken('');
    setWebhookUrl('');
  }

  async function clearChannel(which: 'pushover' | 'webhook') {
    await put(
      which === 'pushover' ? { pushoverAppToken: null, pushoverUserKey: null } : { webhookUrl: null },
      'Channel removed.',
    );
  }

  async function toggle(event: NotifyEvent, value: boolean) {
    if (!state) return;
    // Optimistic
    setState({ ...state, preferences: { ...state.preferences, [event]: value } });
    await put({ preferences: { [event]: value } }, 'Preferences updated.');
  }

  const hasTeam = teamWorkspaces.length > 0 && !!teamId;
  if (!hasTeam) return null;

  const hasPushover = state?.channels.pushover ?? false;
  const hasWebhook = state?.channels.webhook ?? false;
  const inputClass = 'w-full h-10 px-3 bg-surface-1 border border-border-default focus:border-primary outline-none font-mono text-xs';

  function channelActions(which: 'pushover' | 'webhook', connected: boolean) {
    if (!canManage || editing === which) return null;
    return (
      <>
        <button className="btn btn-sm" onClick={() => { setEditing(which); setMsg(null); }} disabled={busy || loading}>
          {connected ? 'Replace' : 'Set up'}
        </button>
        {connected && (
          <button className="btn btn-sm btn-quiet" onClick={() => clearChannel(which)} disabled={busy}>Remove</button>
        )}
      </>
    );
  }

  function formButtons(which: 'pushover' | 'webhook', ready: boolean) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => saveChannel(which)} disabled={busy || !ready} className="btn btn-primary">
          {busy ? 'Saving…' : 'Save channel'}
        </button>
        <button onClick={cancelEdit} disabled={busy} className="btn btn-quiet">Cancel</button>
      </div>
    );
  }

  return (
    <>
      <Section title="Channels">
        <ul className="divide-y divide-border-default" data-testid="notification-channels">
          <ChannelRow
            title="Pushover · team"
            connected={hasPushover}
            sub="The team's own Pushover app. Team alerts go here."
            actions={channelActions('pushover', hasPushover)}
            testId="channel-pushover-team"
          >
            {canManage && editing === 'pushover' ? (
              <>
                <input
                  type="password"
                  aria-label="Pushover app token"
                  value={pushoverAppToken}
                  onChange={(e) => setPushoverAppToken(e.target.value)}
                  placeholder="App token (your Pushover application)"
                  className={inputClass}
                />
                <input
                  type="password"
                  aria-label="Pushover user or group key"
                  value={pushoverKey}
                  onChange={(e) => setPushoverKey(e.target.value)}
                  placeholder="u… (user or group key)"
                  className={inputClass}
                />
                <p className="text-xs text-text-muted">
                  Both are in your Pushover account. The app token comes from creating an application.
                </p>
                {formButtons('pushover', !!pushoverAppToken.trim() && !!pushoverKey.trim())}
              </>
            ) : null}
          </ChannelRow>
          <ChannelRow
            title="Webhook"
            connected={hasWebhook}
            sub="Team alerts as JSON to any URL: Slack, Discord or your own."
            actions={channelActions('webhook', hasWebhook)}
            testId="channel-webhook"
          >
            {canManage && editing === 'webhook' ? (
              <>
                <input
                  type="url"
                  aria-label="Webhook URL"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://example.com/buildd-alerts"
                  className={inputClass}
                />
                {formButtons('webhook', !!webhookUrl.trim())}
              </>
            ) : null}
          </ChannelRow>
        </ul>
      </Section>

      <Section title="Team alerts">
        <Lede className="mb-2">Which events reach this team&apos;s channels.</Lede>
        {loading ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (
          <ul className="divide-y divide-border-default" data-testid="notification-events">
            {EVENT_LABELS.map(({ key, label, hint }) => (
              <li key={key}>
                {canManage ? (
                  <label className="flex items-start justify-between gap-3 py-3 cursor-pointer">
                    <EventText label={label} hint={hint} />
                    <input
                      type="checkbox"
                      checked={state?.preferences[key] ?? true}
                      disabled={busy}
                      onChange={(e) => toggle(key, e.target.checked)}
                      className="mt-1 h-4 w-4 flex-shrink-0"
                    />
                  </label>
                ) : (
                  <div className="flex items-start justify-between gap-3 py-3">
                    <EventText label={label} hint={hint} />
                    <span data-testid="event-state" className="text-sm text-text-secondary shrink-0">
                      {(state?.preferences[key] ?? true) ? 'On' : 'Off'}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {msg && (
        <p role={msg.type === 'error' ? 'alert' : 'status'} className={`text-sm ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>{msg.text}</p>
      )}
    </>
  );
}

function EventText({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-sm text-text-primary">{label}</span>
      <span className="block text-xs text-text-secondary">{hint}</span>
    </span>
  );
}
