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

/** The quiet label above a title, card or section (type role `eyebrow`, = `.section-label`): sans, semibold, sentence case. */
export default function Eyebrow({ children, as: Tag = 'span', tone = 'default', id, className = '' }: EyebrowProps) {
  return (
    <Tag id={id} className={`font-sans text-eyebrow font-semibold ${TONE[tone]} ${className}`}>
      {children}
    </Tag>
  );
}

export { Eyebrow };
