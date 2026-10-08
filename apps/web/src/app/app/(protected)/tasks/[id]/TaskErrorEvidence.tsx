'use client';

/**
 * Agent errors on the task page, sorted by what they mean for the task
 * (lib/trace-consequence.ts) rather than by the fact that they happened:
 *
 *   needs attention  red accent, each row reads what failed → what it affects → action
 *   unclear          shown, neutral
 *   recovered        muted, collapsed
 *   diagnostic       muted, collapsed, never counted
 *
 * Rows clamp for scanning; tapping one opens the complete evidence: a
 * full-screen sheet below md, a large centered modal from md.
 */
import { useCallback, useRef, useState, type RefObject } from 'react';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import Eyebrow from '@/components/ui/Eyebrow';
import Sheet from '@/components/ui/Sheet';
import { ZonedTime } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import {
  affectsLine,
  groupErrorEvidence,
  type ErrorEvidenceContextLine,
  type ErrorEvidenceItem,
} from './error-evidence';

export interface TaskErrorEvidenceProps {
  items: ErrorEvidenceItem[];
  taskTitle: string;
  /** The task's work landed: nothing here may read as a current problem. */
  terminalSucceeded: boolean;
}

type Tone = 'attention' | 'neutral' | 'muted';

const PRESENTATION_CHIP: Record<ErrorEvidenceItem['presentation'], { label: string; tone: ChipTone }> = {
  needs_attention: { label: 'Needs attention', tone: 'error' },
  unclear: { label: 'Unclear', tone: 'muted' },
  recovered: { label: 'Recovered', tone: 'muted' },
  noise: { label: 'Expected', tone: 'muted' },
};


/** A needs-attention item on a task that succeeded reads as recovered. */
function settle(item: ErrorEvidenceItem, terminalSucceeded: boolean): ErrorEvidenceItem {
  if (!terminalSucceeded || item.presentation !== 'needs_attention') return item;
  return { ...item, presentation: 'recovered', reason: 'The task finished and its work landed; this did not stop it.' };
}

/** The "what failed" line: the command, or the first line of a non-command excerpt. */
function headline(item: ErrorEvidenceItem): string {
  if (item.command) return item.command;
  const first = item.output.split('\n').find(l => l.trim() !== '');
  return first?.trim() || item.pattern;
}

function Time({ value, format }: { value: string; format: 'time-seconds' | 'datetime' }) {
  return <ZonedTime value={value} format={format} fallback={`${formatInZone(value, 'UTC', format)}${format === 'time-seconds' ? ' UTC' : ''}`} />;
}

function Row({ item, tone, onOpen }: { item: ErrorEvidenceItem; tone: Tone; onOpen: (item: ErrorEvidenceItem, trigger: HTMLButtonElement) => void }) {
  const accent = tone === 'attention';
  const muted = tone === 'muted';
  return (
    <li className={`border-l-2 ${accent ? 'border-status-error' : 'border-border-default'}`}>
      <button
        type="button"
        data-testid="error-evidence-row"
        data-presentation={item.presentation}
        onClick={e => onOpen(item, e.currentTarget)}
        className="w-full min-h-11 text-left px-3 py-2 hover:bg-surface-2 transition-colors"
      >
        <span
          className={`block font-mono text-body line-clamp-2 [overflow-wrap:anywhere] ${
            accent ? 'text-text-primary font-semibold' : muted ? 'text-text-muted' : 'text-text-secondary'
          }`}
        >
          {headline(item)}
        </span>
        <span className={`block mt-0.5 text-body ${muted ? 'text-text-muted' : 'text-text-secondary'}`}>{affectsLine(item)}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted">
          <span>{item.attempt.label}</span>
          <span aria-hidden="true">·</span>
          <Time value={item.ts} format="time-seconds" />
          {item.exitCode != null && (
            <>
              <span aria-hidden="true">·</span>
              <span>exit {item.exitCode}</span>
            </>
          )}
          <span className={`ml-auto ${muted ? 'text-text-secondary' : 'text-accent-text'}`}>Open full evidence</span>
        </span>
      </button>
      {item.logUrl && (
        <a
          href={item.logUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="error-evidence-log-link"
          className="inline-flex items-center min-h-11 md:min-h-9 px-3 text-meta text-accent-text hover:underline"
        >
          Open CI log
        </a>
      )}
    </li>
  );
}

function Rows({ items, tone, onOpen }: { items: ErrorEvidenceItem[]; tone: Tone; onOpen: (item: ErrorEvidenceItem, trigger: HTMLButtonElement) => void }) {
  return (
    <ul className="space-y-2">
      {items.map(item => (
        <Row key={item.id} item={item} tone={tone} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard || !text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        clipboard.writeText(text).then(() => setCopied(true), () => {});
      }}
      className="min-h-11 md:min-h-9 px-2 text-meta text-text-secondary hover:text-text-primary"
      aria-label={label}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function ContextList({ title, lines }: { title: string; lines: ErrorEvidenceContextLine[] }) {
  return (
    <div>
      <Eyebrow as="h3" tone="muted">{title}</Eyebrow>
      {lines.length === 0 ? (
        <p className="mt-1 text-meta text-text-muted">Nothing recorded.</p>
      ) : (
        <ol className="mt-1 space-y-1">
          {lines.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex gap-2 text-body">
              <span className="shrink-0 text-meta text-text-muted pt-0.5"><Time value={l.ts} format="time-seconds" /></span>
              <span className="min-w-0 font-mono text-text-secondary [overflow-wrap:anywhere]">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EvidenceSheet({
  item,
  taskTitle,
  onClose,
  triggerRef,
}: {
  item: ErrorEvidenceItem;
  taskTitle: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
}) {
  const chip = PRESENTATION_CHIP[item.presentation];
  const pre = 'p-3 bg-surface-2 border border-border-default font-mono text-body text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere]';

  return (
    <Sheet open onClose={onClose} title={taskTitle} height="full" trapFocus
      returnFocusRef={triggerRef} testId="error-evidence-sheet">
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted">
        <span>{item.attempt.label}</span>
        <span aria-hidden="true">·</span>
        <Time value={item.ts} format="datetime" />
        <Chip tone={chip.tone} variant="soft">{chip.label}</Chip>
      </p>
      <p className="mt-1 text-body text-text-secondary">
        {item.reason}
        {item.decidedBy === 'model' && <span className="text-text-muted"> (judged by model)</span>}
      </p>
      <div className="mt-4 space-y-5">
        <p className="text-body text-text-primary">{affectsLine(item)}</p>

        {item.command != null && (
          <section>
            <div className="flex items-center justify-between gap-2">
              <Eyebrow as="h3" tone="muted">Command</Eyebrow>
              <CopyButton text={item.command} label="Copy command" />
            </div>
            <pre data-testid="error-evidence-command" className={`mt-1 ${pre}`}>{item.command}</pre>
            <p className="mt-1 text-meta text-text-muted">Exit code {item.exitCode ?? 'unknown'}</p>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow as="h3" tone="muted">{item.command != null ? 'Output' : 'Excerpt'}</Eyebrow>
            <CopyButton text={item.output} label="Copy output" />
          </div>
          {item.output ? (
            <pre data-testid="error-evidence-output" className={`mt-1 max-h-[60vh] overflow-auto ${pre}`}>{item.output}</pre>
          ) : (
            <p className="mt-1 text-meta text-text-muted">No output was recorded.</p>
          )}
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          <ContextList title="Before" lines={item.before} />
          <ContextList title="After" lines={item.after} />
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
          <dt className="text-text-muted">Pattern</dt>
          <dd className="font-mono text-text-secondary [overflow-wrap:anywhere]">{item.pattern}</dd>
          {item.source && (
            <>
              <dt className="text-text-muted">Source</dt>
              <dd className="font-mono text-text-secondary [overflow-wrap:anywhere]">{item.source}</dd>
            </>
          )}
        </dl>

        {item.logUrl && (
          <a
            href={item.logUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center min-h-11 text-body text-accent-text hover:underline"
          >
            Open CI log
          </a>
        )}
      </div>
    </Sheet>
  );
}

export default function TaskErrorEvidence({ items, taskTitle, terminalSucceeded }: TaskErrorEvidenceProps) {
  const [openItem, setOpenItem] = useState<ErrorEvidenceItem | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const open = useCallback((item: ErrorEvidenceItem, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setOpenItem(item);
  }, []);
  const close = useCallback(() => setOpenItem(null), []);

  if (items.length === 0) return null;

  const groups = groupErrorEvidence(items.map(i => settle(i, terminalSucceeded)));
  const current = groups.attention.length + groups.unclear.length;

  return (
    <section id="agent-error-traces" data-testid="task-error-evidence" className="mb-6">
      <div className="flex items-center gap-2 pb-2 mb-3 border-b border-border-default">
        <Eyebrow as="h2" tone={current > 0 ? 'default' : 'muted'}>Agent errors</Eyebrow>
        {groups.attention.length > 0 && (
          <Chip tone="error" variant="soft" data-testid="error-evidence-attention-count">
            {groups.attention.length} need{groups.attention.length === 1 ? 's' : ''} attention
          </Chip>
        )}
      </div>

      <div className="space-y-4">
        {groups.attention.length > 0 && (
          <div data-testid="error-evidence-attention">
            <Rows items={groups.attention} tone="attention" onOpen={open} />
          </div>
        )}

        {groups.unclear.length > 0 && (
          <div data-testid="error-evidence-unclear">
            <Eyebrow as="h3" tone="muted" className="block mb-2">Unclear</Eyebrow>
            <Rows items={groups.unclear} tone="neutral" onOpen={open} />
          </div>
        )}

        {groups.recovered.length > 0 && (
          <div data-testid="error-evidence-recovered">
            <Disclosure summary="Recovered issues" count={groups.recovered.length}>
              <div className="pt-2">
                <Rows items={groups.recovered} tone="muted" onOpen={open} />
              </div>
            </Disclosure>
          </div>
        )}

        {groups.noise.length > 0 && (
          <div data-testid="error-evidence-noise">
            <Disclosure summary="Diagnostic (expected while exploring)" count={groups.noise.length}>
              <div className="pt-2">
                <Rows items={groups.noise} tone="muted" onOpen={open} />
              </div>
            </Disclosure>
          </div>
        )}
      </div>

      {openItem && <EvidenceSheet item={openItem} taskTitle={taskTitle} onClose={close} triggerRef={triggerRef} />}
    </section>
  );
}
