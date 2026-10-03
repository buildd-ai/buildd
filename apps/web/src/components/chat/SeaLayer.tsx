'use client';

/**
 * The sea behind the chat canvas (sea.ts; knowledge-base: buildd/design/chat-canvas.md, "The
 * sea"). One decorative layer per surface, behind everything, hidden from
 * assistive tech. Pauses while the tab is hidden and holds still for reduced
 * motion. Phone only for now: the desktop canvas keeps its flat ground.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { seaMotion, seaPools, type SeaMood } from './sea';

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setHidden(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return hidden;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(!!mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  return reduced;
}

export default function SeaLayer({ mood, className = '' }: { mood: SeaMood; className?: string }) {
  const motion = seaMotion({ reducedMotion: useReducedMotion(), hidden: useDocumentHidden() });
  return (
    <div aria-hidden="true" data-testid="chat-sea" className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}>
      <div className="sea" data-mood={mood} data-motion={motion}>
        {seaPools(mood).map((p, i) => (
          <div
            key={i}
            className="sea-current"
            style={{
              left: `calc(${p.x}% - ${p.size / 2}px)`,
              top: `calc(${p.y}% - ${p.size / 2}px)`,
              width: p.size,
              height: p.size,
              '--current-s': `${p.thinkingSeconds}s`,
              '--delay': `${p.delay}s`,
              '--dx': `${p.dx}px`,
              '--dy': `${p.dy}px`,
            } as CSSProperties}
          >
            <div
              data-testid="sea-pool"
              className="sea-pool"
              style={{ '--pool-c': p.colour, '--drift-s': `${p.calmSeconds}s` } as CSSProperties}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
