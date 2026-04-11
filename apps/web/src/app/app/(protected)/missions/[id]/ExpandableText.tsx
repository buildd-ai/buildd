'use client';

import { useState } from 'react';

export default function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <p
      className={`text-[12px] text-text-secondary italic leading-relaxed mt-1 cursor-pointer ${expanded ? '' : 'line-clamp-3'}`}
      onClick={() => setExpanded(!expanded)}
      title={expanded ? 'Click to collapse' : 'Click to expand'}
    >
      {text}
    </p>
  );
}
