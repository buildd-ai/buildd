import type { ReactNode } from 'react';

export type EyebrowTone = 'default' | 'muted' | 'accent';

const TONE: Record<EyebrowTone, string> = {
  default: 'text-text-primary',
  muted: 'text-text-muted',
  accent: 'text-accent-text',
};

export interface EyebrowProps {
  children: ReactNode;
  as?: 'span' | 'p' | 'h2' | 'h3';
  tone?: EyebrowTone;
  id?: string;
  className?: string;
}

/** The small uppercase label above a title, card or section (type role `eyebrow`, = `.section-label`). */
export default function Eyebrow({ children, as: Tag = 'span', tone = 'default', id, className = '' }: EyebrowProps) {
  return (
    <Tag id={id} className={`font-mono text-eyebrow font-bold uppercase tracking-[2px] ${TONE[tone]} ${className}`}>
      {children}
    </Tag>
  );
}

export { Eyebrow };
