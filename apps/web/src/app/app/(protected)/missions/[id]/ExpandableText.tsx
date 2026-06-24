'use client';

import { useState } from 'react';

interface Segment {
  type: 'text' | 'code';
  content: string;
  language: string;
}

interface PlanTask {
  ref: string;
  title: string;
}

function parseSegments(text: string): Segment[] {
  const parts: Segment[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const prose = text.slice(last, m.index).trim();
      if (prose) parts.push({ type: 'text', content: prose, language: '' });
    }
    parts.push({ type: 'code', content: m[2].trim(), language: m[1] || 'text' });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const prose = text.slice(last).trim();
    if (prose) parts.push({ type: 'text', content: prose, language: '' });
  }
  return parts;
}

function tryParsePlanTasks(jsonStr: string): PlanTask[] | null {
  try {
    const parsed = JSON.parse(jsonStr);
    const tasks = parsed.tasks;
    if (Array.isArray(tasks) && tasks.length > 0) {
      return tasks.map((t: Record<string, unknown>) => ({
        ref: String(t.ref ?? t.id ?? ''),
        title: String(t.title ?? ''),
      }));
    }
    return null;
  } catch {
    return null;
  }
}

function CollapsibleCode({ content, language }: { content: string; language: string }) {
  const [open, setOpen] = useState(false);
  const tasks = language === 'json' ? tryParsePlanTasks(content) : null;
  const label = tasks
    ? `Plan · ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`
    : language && language !== 'text'
    ? language
    : 'Output';

  return (
    <div className="mt-2 border border-border-default text-[11px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-text-muted hover:text-text-secondary transition-colors text-left"
      >
        <span className="font-mono tracking-wide">{label}</span>
        <span className="opacity-50 text-[10px]">{open ? '▲' : '▼'}</span>
      </button>

      {open && tasks && (
        <ul className="border-t border-border-default px-3 py-2 space-y-1.5">
          {tasks.map((task, i) => (
            <li key={i} className="flex items-start gap-2 text-[11px]">
              {task.ref && (
                <span className="text-text-muted font-mono shrink-0 w-16 truncate">{task.ref}</span>
              )}
              <span className="text-text-secondary leading-snug">{task.title}</span>
            </li>
          ))}
        </ul>
      )}

      {open && !tasks && (
        <pre className="border-t border-border-default px-3 py-2 text-text-secondary overflow-auto max-h-48 font-mono leading-relaxed whitespace-pre-wrap text-[10px]">
          {content}
        </pre>
      )}
    </div>
  );
}

export default function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const segments = parseSegments(text);
  const proseSegments = segments.filter((s) => s.type === 'text');
  const codeSegments = segments.filter((s) => s.type === 'code');
  const prose = proseSegments.map((s) => s.content).join('\n\n');
  // Roughly 3 wrapped lines at text-[12px] on a ~600px container
  const isLong = prose.length > 180;

  return (
    <div className="mt-1">
      {prose && (
        <div>
          <p
            className={`text-[12px] text-text-secondary italic leading-relaxed${expanded ? '' : ' line-clamp-3'}`}
          >
            {prose}
          </p>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-[11px] text-text-muted hover:text-text-secondary mt-0.5 transition-colors"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {codeSegments.map((seg, i) => (
        <CollapsibleCode key={i} content={seg.content} language={seg.language} />
      ))}
    </div>
  );
}
