'use client';

/**
 * The mission sheet's body (docs/design/chat-canvas.md, "Mission sheet"): the
 * context card, the ASK ABOUT rows and the composer's locked scope cell, all
 * read from the mission's live view. The title shows once, in the card.
 */
import type { BuilddObjectRef } from './chat-contract';
import type { CanvasSuggestion } from './canvas-empty';
import { useObjectEntry } from './objects/ObjectStoreProvider';
import { missionTone, type Tone } from './objects/parts';
import { missionAskRows, missionInsight, missionScopeLabel, missionSheetState, segments } from './mission-sheet';

const BADGE: Record<Tone, string> = {
  ok: 'border-[var(--mood-landed)] text-[var(--mood-landed)]',
  attention: 'border-[var(--mood-needs)] text-[var(--mood-needs)]',
  bad: 'border-[var(--mood-needs)] text-[var(--mood-needs)]',
  live: 'border-[var(--chat-rule-strong)] text-[var(--chat-text)]',
  idle: 'border-[var(--chat-rule)] text-[var(--chat-muted)]',
};

function Meter({ label, done, total, testId, unchecked }: { label: string; done: number; total: number; testId: string; unchecked: string }) {
  const segs = segments(done, total);
  return (
    <div data-testid={testId} className="min-w-0 px-3 py-2.5">
      <p className="flex items-baseline justify-between gap-2 font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.14em] text-[var(--chat-muted)]">
        <span>{label}</span>
        <span data-testid={`${testId}-count`} className="text-[var(--chat-text)]">{total > 0 ? `${done}/${total}` : 'none'}</span>
      </p>
      <div aria-hidden="true" className="mt-2 flex h-1.5 gap-[3px]">
        {segs.map((on, i) => (
          <span key={i} data-on={on ? 'true' : 'false'} className={`min-w-0 flex-1 ${on ? 'bg-[var(--mood-landed)]' : unchecked}`} />
        ))}
      </div>
    </div>
  );
}

export function MissionContextCard({ objRef }: { objRef: BuilddObjectRef }) {
  const { view } = useObjectEntry(objRef);
  const mission = view?.kind === 'mission' ? view : null;
  const s = mission ? missionSheetState(mission) : null;
  const insight = s ? missionInsight(s) : null;
  const tone = mission ? missionTone(mission.stateLabel, mission.status) : null;
  const title = mission?.title ?? objRef.title ?? 'This mission';
  return (
    <section
      data-testid="mission-context-card"
      data-disagrees={insight?.disagrees ? 'true' : undefined}
      className="border border-[var(--chat-rule-strong)] bg-[var(--chat-surface)] shadow-[4px_4px_0_0_var(--chat-rule-strong)]"
    >
      <div className="px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.16em] text-[var(--chat-muted)]">Mission</span>
          {mission && tone && (
            <span data-testid="mission-context-status" className={`inline-flex h-5 shrink-0 items-center border px-1.5 font-mono text-[11px] md:text-[10.5px] uppercase tracking-[.12em] ${BADGE[tone]}`}>
              {mission.stateLabel}
            </span>
          )}
        </div>
        <h2 data-testid="mission-context-title" className="mt-1.5 font-voice text-[22px] leading-[1.15] text-[var(--chat-text)] [overflow-wrap:anywhere]">{title}</h2>
      </div>
      {s && (
        <div className="grid grid-cols-2 divide-x divide-[var(--chat-rule)] border-t border-[var(--chat-rule)]">
          <Meter label="Landed" testId="mission-context-landed" done={s.landed.done} total={s.landed.total} unchecked="border border-[var(--chat-rule-strong)]" />
          <Meter label="Goal" testId="mission-context-goal" done={s.goal.passed} total={s.goal.total} unchecked="border border-[var(--mood-needs)]" />
        </div>
      )}
      {insight && (
        <p data-testid="mission-context-insight" className="flex items-start gap-2 border-t border-[var(--chat-rule)] px-3 py-2.5 font-voice text-[15.5px] italic leading-snug text-[var(--chat-muted)]">
          {insight.disagrees && <span aria-hidden="true" data-testid="mission-context-flag" className="mt-[7px] h-2 w-2 shrink-0 bg-[var(--mood-needs)]" />}
          <span>{insight.text}</span>
        </p>
      )}
    </section>
  );
}

export function MissionAskAbout({ objRef, onPick }: { objRef: BuilddObjectRef; onPick(s: CanvasSuggestion): void }) {
  const { view } = useObjectEntry(objRef);
  const mission = view?.kind === 'mission' ? view : null;
  const rows = missionAskRows(mission ? missionSheetState(mission) : null);
  return (
    <section data-testid="canvas-suggestions" aria-label="Ask about" className="mt-6 border border-[var(--chat-rule)] bg-[var(--chat-ground)]">
      <div className="flex h-[30px] items-center border-b border-[var(--chat-rule)] px-3 font-mono text-[11px] uppercase tracking-[.16em] text-[var(--chat-muted)]">
        Ask about
      </div>
      <ul className="divide-y divide-[var(--chat-rule)]">
        {rows.map((sg, i) => {
          const copper = sg.tone === 'needs';
          return (
            <li key={sg.label}>
              <button
                type="button"
                data-testid="canvas-suggestion"
                data-tone={sg.tone}
                onClick={() => onPick(sg)}
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--chat-raised)]"
              >
                <span aria-hidden="true" className={`shrink-0 font-mono text-[11px] ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-dim)]'}`}>{String(i + 1).padStart(2, '0')}</span>
                <span data-testid="canvas-suggestion-label" className={`min-w-0 flex-1 font-voice text-[19px] leading-tight ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-text)]'}`}>{sg.label}</span>
                <span aria-hidden="true" className={`shrink-0 font-mono text-[14px] ${copper ? 'text-[var(--mood-needs)]' : 'text-[var(--chat-muted)]'}`}>→</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The composer's scope cell, locked to the mission: a lock and `mission · <workspace>`. */
export function MissionScopeCell({ objRef }: { objRef: BuilddObjectRef }) {
  const { view } = useObjectEntry(objRef);
  const ws = view?.kind === 'mission' ? view.workspaceName : null;
  return (
    <span
      data-testid="composer-scope-locked"
      aria-label={`Scope locked to ${missionScopeLabel(ws)}`}
      className="flex h-full min-w-0 items-center gap-2 px-3 font-mono text-[12px] text-[var(--chat-muted)]"
    >
      <svg aria-hidden="true" data-testid="composer-scope-lock" viewBox="0 0 12 14" className="h-3.5 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
        <rect x="1" y="6" width="10" height="7" />
        <path d="M3.5 6V3.5h5V6" />
      </svg>
      <span className="min-w-0 truncate">{missionScopeLabel(ws)}</span>
    </span>
  );
}
