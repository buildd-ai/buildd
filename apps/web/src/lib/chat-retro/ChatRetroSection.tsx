'use client';

/**
 * Settings → AI features → Chat session retros (experiment; see ./REMOVAL.md).
 * Two switches and a read-only list of recent lessons, for team admins.
 * Imports only the pure ./settings module: nothing here touches the DB.
 */
import { useCallback, useEffect, useState } from 'react';
import Switch from '@/components/ui/Switch';
import { useConfirm } from '@/components/useConfirm';
import { CHAT_RETRO_DEFAULT, type ChatRetroSettings } from './settings';

interface LessonListItem {
  id: string;
  status: string;
  skipReason: string | null;
  userTurns: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  satisfied: string | null;
  wastedTokens: number;
  primaryCause: string | null;
  fixClass: string | null;
  toolName: string | null;
  createdAt: string;
}

function lessonLine(l: LessonListItem): string {
  if (l.status === 'skipped') return `skipped (${l.skipReason ?? 'no reason'})`;
  if (l.status === 'failed') return 'not judged (the decision call failed)';
  const cause = l.primaryCause ? `${l.primaryCause.replace(/_/g, ' ')}${l.toolName ? ` via ${l.toolName}` : ''}` : 'no waste found';
  return `${cause}${l.fixClass ? `, fix: ${l.fixClass.replace(/_/g, ' ')}` : ''}${l.satisfied ? `, satisfied: ${l.satisfied}` : ''}`;
}

export default function ChatRetroSection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [settings, setSettings] = useState<ChatRetroSettings>({ ...CHAT_RETRO_DEFAULT });
  const [globallyEnabled, setGloballyEnabled] = useState(true);
  const [lessons, setLessons] = useState<LessonListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    if (!isAdmin) { setLoaded(true); return; }
    try {
      const res = await fetch(`/api/teams/${teamId}/chat-retro`);
      if (res.ok) {
        const d = await res.json();
        setSettings({ lessons: d.settings?.lessons === true, proposals: d.settings?.proposals === true });
        setGloballyEnabled(d.globallyEnabled !== false);
        setLessons(Array.isArray(d.lessons) ? d.lessons : []);
      }
    } catch { /* the section shows its defaults */ }
    finally { setLoaded(true); }
  }, [teamId, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  async function save(body: Partial<ChatRetroSettings>) {
    setMsg(null);
    const before = settings;
    try {
      const res = await fetch(`/api/teams/${teamId}/chat-retro`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? 'Could not save');
      setSettings(d.settings);
      if (d.deletedLessons > 0 || !d.settings.lessons) setLessons([]);
      setMsg({ tone: 'ok', text: d.deletedLessons > 0 ? `Saved. Deleted ${d.deletedLessons} lessons.` : 'Saved' });
    } catch (e) {
      setSettings(before);
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    }
  }

  const disabled = !isAdmin || !loaded;

  return (
    <div id="chat-retro" className="mt-10 max-w-4xl scroll-mt-20" data-testid="chat-retro-settings">
      <h2 className="mb-2 flex items-baseline gap-2 font-mono text-[15px] font-bold text-text-primary">
        Chat session retros <span className="text-[12px] font-normal text-text-muted">experiment, off unless you turn it on</span>
      </h2>
      <div className="card divide-y divide-border-default">
        <div className="px-4 py-3 space-y-1.5 text-xs text-text-secondary">
          <p><span className="text-text-primary">What is analysed:</span> your team&apos;s chat sessions with the buildd agent, once a day, after a conversation has been quiet for 30 minutes.</p>
          <p><span className="text-text-primary">What is stored:</span> labels and counts only, such as how many turns and tokens a session took, what kind of problem slowed it down, and which conversation and turn it was in. No message text is stored.</p>
          <p><span className="text-text-primary">How it is judged:</span> a short summary of the session (each of your messages cut to 300 characters, plus tool names and sizes) is sent once to your team&apos;s decision model, the same one that routes chat turns. The summary is not kept.</p>
          <p><span className="text-text-primary">Who sees it:</span> your team&apos;s owners and admins.</p>
          <p><span className="text-text-primary">What it produces:</span> with suggestions on, at most 2 suggested improvements a day, filed as tasks in your workspace. Nothing is changed automatically.</p>
          <p><span className="text-text-primary">Turning it off:</span> switch off recording lessons at any time. That also stops suggestions and deletes every lesson recorded so far.</p>
          {!globallyEnabled && <p className="text-status-warning">Paused for everyone on this deployment right now, whatever you choose here.</p>}
        </div>
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <span className="min-w-0">
            <span id="chat-retro-lessons-label" className="block text-sm text-text-primary">Record lessons</span>
            <span className="block text-xs text-text-muted">Labels and counts for each chat session. Nothing is filed.</span>
          </span>
          <Switch
            labelledBy="chat-retro-lessons-label"
            className="mt-1"
            checked={settings.lessons}
            disabled={disabled}
            onChange={async (next) => {
              if (!next && !(await confirm({
                title: 'Turn off chat session retros?',
                message: 'This stops suggestions too and deletes every lesson recorded so far.',
                confirmLabel: 'Turn off and delete',
                variant: 'danger',
              }))) return;
              setSettings(s => ({ lessons: next, proposals: next ? s.proposals : false }));
              void save({ lessons: next });
            }}
          />
        </div>
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <span className="min-w-0">
            <span id="chat-retro-proposals-label" className="block text-sm text-text-primary">File suggested improvements</span>
            <span className="block text-xs text-text-muted">At most 2 a day, as tasks in your workspace. Needs lessons on.</span>
          </span>
          <Switch
            labelledBy="chat-retro-proposals-label"
            className="mt-1"
            checked={settings.proposals}
            disabled={disabled || !settings.lessons}
            onChange={(next) => {
              setSettings(s => ({ ...s, proposals: next }));
              void save({ proposals: next });
            }}
          />
        </div>
        {isAdmin && settings.lessons && (
          <div className="px-4 py-3" data-testid="chat-retro-lessons">
            <span className="block text-sm text-text-primary mb-1.5">Recent lessons</span>
            {lessons.length === 0 ? (
              <p className="text-xs text-text-muted">None yet. The first ones appear the day after a chat session.</p>
            ) : (
              <ul className="space-y-1 text-xs text-text-secondary">
                {lessons.map(l => (
                  <li key={l.id} className="flex flex-wrap gap-x-3">
                    <span className="text-text-muted">{new Date(l.createdAt).toLocaleDateString()}</span>
                    <span>{l.userTurns} asks, {l.inputTokens + l.outputTokens} tokens</span>
                    <span className="text-text-primary">{lessonLine(l)}</span>
                    {l.wastedTokens > 0 && <span className="text-text-muted">{l.wastedTokens} tokens wasted</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 min-h-5">
        {isAdmin
          ? msg && <span role="status" className={`text-xs ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>{msg.text}</span>
          : <p className="text-xs text-text-muted">Only a team owner or admin can change this or see its lessons.</p>}
      </div>
      {confirmDialog}
    </div>
  );
}
