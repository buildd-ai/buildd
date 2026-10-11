'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Without layout (SSR, tests) there is nothing to measure; long text gets the toggle anyway. */
const UNMEASURED_LONG_CHARS = 90;

/**
 * Text that holds to `lines` lines on a phone and runs free from `md` up,
 * with a "more" / "less" toggle only when the text really overflows. The
 * toggle is a sibling of the text, never inside it, so the text can sit in a
 * button without nesting one.
 */
export function useClamp(text: string) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(text.length > UNMEASURED_LONG_CHARS);

  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      if (open) return; // expanded: keep the toggle so it can collapse again
      if (el.clientHeight === 0) {
        setOverflows(text.length > UNMEASURED_LONG_CHARS);
        return;
      }
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [text, open]);

  return { ref, open, setOpen, overflows };
}

export default function ClampText({
  text,
  lines = 2,
  className = '',
  testId,
  toggleClassName = '',
}: {
  text: ReactNode & string;
  lines?: 2 | 3;
  className?: string;
  testId?: string;
  toggleClassName?: string;
}) {
  const { ref, open, setOpen, overflows } = useClamp(text);
  const clamp = lines === 3 ? 'line-clamp-3' : 'line-clamp-2';
  return (
    <>
      <p
        ref={ref as React.RefObject<HTMLParagraphElement>}
        data-testid={testId}
        data-clamped={open ? 'false' : 'true'}
        className={`${className} ${open ? '' : `${clamp} md:line-clamp-none`}`}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          data-testid="clamp-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`md:hidden mt-1 min-h-8 font-mono text-chip font-semibold text-accent-text underline ${toggleClassName}`}
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </>
  );
}
