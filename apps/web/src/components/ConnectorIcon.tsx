'use client';

import { useState } from 'react';

/**
 * Connector logo. For a connector `iconUrl` is an inlined `data:` URL
 * (lib/connector-icon.ts); catalog presets may still pass a remote URL. Always
 * an <img>, never inline SVG markup, so an SVG icon cannot run script. A
 * missing or broken image falls back to the name's first letter.
 */
export function ConnectorIcon({ name, iconUrl, size = 20 }: { name: string; iconUrl?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (iconUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- arbitrary third-party hosts; next/image needs each allow-listed
      <img
        src={iconUrl}
        alt=""
        style={box}
        className="shrink-0 object-contain"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.round(size * 0.55) }}
      className="shrink-0 inline-flex items-center justify-center bg-surface-3 border border-border-default text-text-secondary font-mono uppercase"
    >
      {name.trim().charAt(0) || '?'}
    </span>
  );
}
