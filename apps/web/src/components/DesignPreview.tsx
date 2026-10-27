'use client';

/**
 * A design (one HTML file an agent produced, every screen a `section[data-screen]`)
 * shown inside buildd at true size, from the signed storage URL, in a sandbox.
 *
 * Security (the design is untrusted agent output):
 * - The iframe's `sandbox` is exactly `allow-scripts`: the document runs in an
 *   opaque origin, cannot reach buildd's cookies or DOM, cannot navigate this
 *   page and cannot open popups. Never add `allow-same-origin`.
 * - `src` is the per-viewer, short-lived signed URL the server made for this
 *   render; the component holds it in memory only. No inline-document
 *   attribute, no fetching the file into buildd's document: the bytes never
 *   touch our origin.
 * - `referrerPolicy="no-referrer"`: the storage host never sees the buildd URL.
 *
 * `DesignPreview.test.tsx` pins those attributes; the artifact page's CSP
 * (next.config.mjs, artifactPageCsp) limits `frame-src` to the storage origin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { deviceForWidth, fitScale, frameSrc, pickStartScreen, type DesignScreen } from '@/lib/design-preview';
import { useMissionStage } from '@/components/design-stage';

export interface DesignPreviewProps {
  artifactId: string;
  title: string;
  /** The artifact revision being shown; part of the frame's label. */
  revision: number;
  /** The signed storage URL for that revision's file; null when storage cannot serve it. */
  frameUrl: string | null;
  screens: DesignScreen[];
  /** `?screen=` from the deep link; the first screen when absent or unknown. */
  initialScreenId?: string | null;
  downloadUrl?: string | null;
  fileName?: string | null;
  sizeLabel?: string | null;
}

type Zoom = 'fit' | 'full';

/** Rewrites `?screen=` in place so the address bar stays a shareable deep link. */
function syncScreenParam(screenId: string | null) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (screenId) url.searchParams.set('screen', screenId);
  else url.searchParams.delete('screen');
  window.history.replaceState(window.history.state, '', url);
}

export default function DesignPreview({
  artifactId,
  title,
  revision,
  frameUrl,
  screens,
  initialScreenId,
  downloadUrl,
  fileName,
  sizeLabel,
}: DesignPreviewProps) {
  const stage = useMissionStage();
  const [screenId, setScreenId] = useState<string | null>(() => pickStartScreen(screens, { initialId: initialScreenId }));
  // The device is only known in the browser: pick the stage's screen for it once mounted,
  // unless the link named a screen or the viewer already chose one.
  const chosen = useRef(false);
  useEffect(() => {
    if (chosen.current || (initialScreenId && screens.some((s) => s.id === initialScreenId))) return;
    setScreenId(pickStartScreen(screens, { device: deviceForWidth(window.innerWidth), stage }));
  }, [screens, stage, initialScreenId]);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [columnWidth, setColumnWidth] = useState<number | null>(null);
  // The frame is cross-origin and sandboxed, so `load` is all we can know of it.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);

  const screen = useMemo(() => screens.find((s) => s.id === screenId) ?? null, [screens, screenId]);
  const viewport = screen?.viewport ?? null;

  // The column's width, kept current so the frame refits on rotate or resize.
  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const measure = () => setColumnWidth(el.clientWidth || null);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = zoom === 'full' || !viewport || !columnWidth ? 1 : fitScale(viewport.width, columnWidth);
  const label = `Design preview · ${title} · revision ${revision}`;
  const shortLabel = `Revision ${revision}`; // the page H1 already carries the title
  const src = frameUrl ? frameSrc(frameUrl, screenId) : null;

  // `load` fires before a sandboxed, scaled frame has necessarily painted: hold the
  // status overlay two more frames so a not-yet-painted frame reads as loading, never blank.
  const [painted, setPainted] = useState<string | null>(null);
  const [frameError, setFrameError] = useState(false);
  useEffect(() => {
    if (loadedSrc !== artifactId) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setPainted(artifactId)));
    return () => cancelAnimationFrame(id);
  }, [loadedSrc, artifactId]);
  const loaded = !!src && loadedSrc === artifactId && painted === artifactId;
  useEffect(() => {
    setSlow(false);
    setFrameError(false);
    if (!src || loaded) return;
    const t = setTimeout(() => setSlow(true), 8000);
    const et = setTimeout(() => {
      // If still not loaded after 15 seconds, assume an error (frame failed to load content)
      if (loadedSrc === artifactId) setFrameError(true);
    }, 15000);
    return () => {
      clearTimeout(t);
      clearTimeout(et);
    };
  }, [src, loaded, loadedSrc, artifactId]);

  const pick = useCallback((id: string) => {
    chosen.current = true;
    setScreenId(id);
    syncScreenParam(id);
  }, []);

  return (
    <div data-testid="design-preview" className="min-w-0">
      {/* Chrome: label, picker, zoom, download. Tokens only, both themes. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
        <p className="text-meta text-text-secondary min-w-0 flex-1 basis-full sm:basis-auto line-clamp-2 break-words" data-testid="design-preview-label" title={label}>
          {shortLabel}
        </p>
        {screens.length > 0 ? (
          <div className="flex items-center gap-2 text-meta text-text-secondary min-w-0 shrink">
            <span className="sr-only sm:not-sr-only" aria-hidden="true">Screen</span>
            <Select
              testId="design-screen-picker"
              aria-label="Screen"
              value={screenId ?? ''}
              onChange={pick}
              options={screens.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              className="max-w-[44vw] sm:max-w-xs"
            />
            {viewport ? (
              <span data-testid="design-viewport" className="shrink-0 font-mono text-text-muted">{viewport.width}×{viewport.height}</span>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap basis-full sm:basis-auto justify-end sm:justify-start">
          {viewport ? (
            <div className="flex items-center rounded-md border border-border-default overflow-hidden" role="group" aria-label="Zoom">
              <button
                type="button"
                data-testid="design-zoom-fit"
                aria-pressed={zoom === 'fit'}
                onClick={() => setZoom('fit')}
                className={`min-h-[44px] sm:min-h-0 px-2.5 py-1.5 text-meta transition-colors ${zoom === 'fit' ? 'bg-surface-4 text-text-primary' : 'bg-surface-3 text-text-secondary hover:text-text-primary'}`}
              >
                Fit
              </button>
              <button
                type="button"
                data-testid="design-zoom-full"
                aria-pressed={zoom === 'full'}
                onClick={() => setZoom('full')}
                className={`min-h-[44px] sm:min-h-0 px-2.5 py-1.5 text-meta border-l border-border-default transition-colors ${zoom === 'full' ? 'bg-surface-4 text-text-primary' : 'bg-surface-3 text-text-secondary hover:text-text-primary'}`}
              >
                100%
              </button>
            </div>
          ) : null}
          {downloadUrl ? (
            <a
              href={downloadUrl}
              data-testid="design-download"
              className="min-h-[44px] sm:min-h-0 inline-flex items-center px-3 py-1.5 text-meta bg-surface-3 border border-border-default text-text-secondary hover:bg-surface-4 hover:text-text-primary transition-colors"
            >
              Download
            </a>
          ) : null}
        </div>
      </div>

      {/* The frame column: scrolls when the screen is shown at 100% and is wider than the column. */}
      <div
        ref={columnRef}
        data-testid="design-frame-column"
        className="bg-surface-2 border border-border-default rounded-md overflow-auto"
      >
        <div
          data-testid="design-frame-box"
          className="relative overflow-hidden bg-surface-2"
          style={
            viewport && src
              ? { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) }
              : undefined
          }
        >
          {src ? (
            <iframe
              key={artifactId}
              src={src}
              title={label}
              aria-label={label}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              data-testid="design-frame"
              onLoad={() => setLoadedSrc(artifactId)}
              className="block border-0 bg-surface-2"
              style={
                viewport
                  ? { width: viewport.width, height: viewport.height, transform: `scale(${scale})`, transformOrigin: 'top left' }
                  : { width: '100%', height: '70vh' }
              }
            />
          ) : null}
          {src && !loaded ? (
            <div
              data-testid="design-frame-loading"
              role="status"
              className="absolute inset-0 flex items-center justify-center p-4 text-center text-body text-text-muted bg-surface-2"
            >
              {frameError
                ? 'Failed to load design: the file could not be retrieved. Download the file to open it.'
                : slow
                  ? 'Still loading the design. If it stays blank, download the file to open it.'
                  : 'Loading design…'}
            </div>
          ) : null}
          {!src ? (
            <div
              data-testid="design-frame-unavailable"
              className="flex items-center justify-center w-full min-h-[160px] p-4 text-center text-body text-text-muted"
              style={{ minHeight: viewport ? Math.min(viewport.height, 320) : undefined, height: viewport ? undefined : '40vh' }}
            >
              Preview unavailable: file storage is not configured here. Download the file to open it.
            </div>
          ) : null}
        </div>
      </div>

      {(fileName || sizeLabel) && (
        <p className="mt-2 text-meta text-text-muted truncate">
          {fileName}
          {fileName && sizeLabel ? ' · ' : ''}
          {sizeLabel}
          {viewport && scale < 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}
        </p>
      )}
    </div>
  );
}
