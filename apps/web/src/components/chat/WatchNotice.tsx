/**
 * A watch the person set has fired: "#123 merged." In the chat v3 language
 * (docs/design/chat-canvas.md, "Mobile canvas"): a square card with a 1px
 * rule and a 3px offset shadow, the sentence in Newsreader, the chrome in
 * mono. Colour carries meaning only: the 8px square is landed (green) for done
 * or merged, needs-you (copper) when it waits on you, red when it failed.
 * Plain words only, never a tool or event name.
 */
import Link from 'next/link';
import type { ChatWatchNotice } from './chat-contract';

const TONE: Record<ChatWatchNotice['tone'], { dot: string; word: string; cls: string }> = {
  ok: { dot: 'bg-[var(--mood-landed)]', word: 'Landed', cls: 'text-[var(--mood-landed)]' },
  attention: { dot: 'bg-[var(--mood-needs)]', word: 'Needs you', cls: 'text-[var(--mood-needs)]' },
  bad: { dot: 'bg-status-error', word: 'Failed', cls: 'text-status-error' },
};

export default function WatchNotice({ text, notice }: { text: string; notice: ChatWatchNotice }) {
  const tone = TONE[notice.tone];
  const external = !!notice.href && /^https?:\/\//.test(notice.href);
  const linkCls = 'flex min-h-11 items-center justify-between gap-3 border-t border-[var(--chat-rule)] px-4 font-mono text-[12px] font-semibold uppercase tracking-[.12em] text-[var(--chat-text)] hover:bg-[var(--chat-raised)]';
  return (
    <div
      data-testid="watch-notice"
      data-event={notice.eventType}
      data-tone={notice.tone}
      className="border border-[var(--chat-rule-strong)] bg-[var(--chat-surface)] shadow-[3px_3px_0_0_var(--chat-rule)]"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--chat-rule)] px-4 py-2 font-mono text-[11px] uppercase tracking-[.14em]">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${tone.dot}`} />
        <span className={`shrink-0 font-semibold ${tone.cls}`}>{tone.word}</span>
        <span className="min-w-0 truncate text-[var(--chat-muted)] normal-case tracking-normal">{`· ${notice.label}`}</span>
      </div>
      <div className="px-4 pb-3 pt-2.5">
        <p className="font-voice text-[21px] leading-[1.3] text-[var(--chat-text)] [overflow-wrap:anywhere]">{text}</p>
        {notice.detail && <p className="mt-0.5 font-voice text-[15.5px] italic leading-[1.45] text-[var(--chat-muted)] [overflow-wrap:anywhere]">{notice.detail}</p>}
      </div>
      {notice.href && notice.linkText && (external
        ? <a href={notice.href} target="_blank" rel="noreferrer" className={linkCls}><span>{notice.linkText}</span><span aria-hidden="true">↗</span></a>
        : <Link href={notice.href} className={linkCls}><span>{notice.linkText}</span><span aria-hidden="true">→</span></Link>)}
    </div>
  );
}
