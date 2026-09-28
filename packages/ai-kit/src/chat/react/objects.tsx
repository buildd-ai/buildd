'use client';

/**
 * Objects in the chat, rendered through the app's own renderers: the store
 * context, the live-entry hook, a card and a pane that look a ref's kind up
 * in a renderer map (falling back to the ref's `fallbackText`), and the
 * pinned strip that keeps the object the conversation is about at the top.
 *
 * The kit owns the mechanism (one live copy per ref, the pin, open beside /
 * open as a sheet, show / hide the detail); the app owns what each kind looks
 * like. Styled only through `kit-*` classes and `--kit-*` values.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { refKey, type ObjectRef } from '@builddai/ai-kit/chat/contract';
import { createObjectStore, idleEntry, type ObjectEntry, type ObjectSource, type ObjectStore } from './object-store';

// ── Store context ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const StoreContext = createContext<ObjectStore<any, any, any> | null>(null);

export interface ObjectStoreProviderProps<R extends ObjectRef, V> {
  /** Build a store over this source (once per source identity). */
  source?: ObjectSource<R, V>;
  /** Or pass a store you built (with a sidecar, a classifier, a test clock). */
  store?: ObjectStore<R, V, unknown>;
  children: ReactNode;
}

/** One store per chat surface. Pass `store` or `source`. */
export function ObjectStoreProvider<R extends ObjectRef, V>({ source, store: given, children }: ObjectStoreProviderProps<R, V>) {
  const store = useMemo(() => {
    if (given) return given;
    if (!source) throw new Error('ObjectStoreProvider needs a store or a source');
    return createObjectStore(source);
  }, [given, source]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useObjectStore<R extends ObjectRef = ObjectRef, V = unknown, X = unknown>(): ObjectStore<R, V, X> {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useObjectStore outside ObjectStoreProvider');
  return store as ObjectStore<R, V, X>;
}

/** The live entry for one ref; subscribes while mounted, keyed on `kind:id`. */
export function useObjectEntry<V = unknown, R extends ObjectRef = ObjectRef>(ref: R): ObjectEntry<V> {
  const store = useObjectStore<R, V>();
  const key = refKey(ref);
  const latest = useRef(ref);
  latest.current = ref;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ref's identity, not the object
  const subscribe = useCallback((l: () => void) => store.subscribe(latest.current, l), [store, key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const get = useCallback(() => store.get(latest.current), [store, key]);
  return useSyncExternalStore(subscribe, get, idleEntry<V>);
}

// ── Renderers ─────────────────────────────────────────────────────────────────

export type ObjectVariant = 'pane' | 'sheet';

/** How the app draws one kind. `matches` rejects a view of the wrong shape (shows the placeholder). */
export interface ObjectRenderer<R extends ObjectRef, V> {
  card(ref: R, view: V): ReactNode;
  pane?(ref: R, view: V, variant: ObjectVariant): ReactNode;
  matches?(ref: R, view: V): boolean;
}

export type ObjectRenderers<R extends ObjectRef, V> = Partial<Record<R['kind'], ObjectRenderer<R, V>>>;

/** A ref with no renderer, not loaded yet, or gone: its fallback text, and the error when there is one. */
export function ObjectPlaceholder({ objRef, error, loading }: { objRef: ObjectRef; error?: string | null; loading?: boolean }) {
  return (
    <div className="kit-object-placeholder" data-kind={objRef.kind} data-loading={loading || undefined} data-testid="kit-object-placeholder">
      <span>{objRef.title ?? objRef.fallbackText}</span>
      {error && <span className="kit-note" role="status">{error}</span>}
    </div>
  );
}

function useRendered<R extends ObjectRef, V>(objRef: R, renderers: ObjectRenderers<R, V>) {
  const r = renderers[objRef.kind as R['kind']] as ObjectRenderer<R, V> | undefined;
  return r;
}

/** The inline card for a ref (in the feed). */
export function ObjectCard<R extends ObjectRef, V>({ objRef, renderers }: { objRef: R; renderers: ObjectRenderers<R, V> }) {
  const r = useRendered(objRef, renderers);
  if (!r) return <ObjectPlaceholder objRef={objRef} />;
  return <LiveObject objRef={objRef} draw={(view) => r.card(objRef, view)} matches={r.matches} />;
}

/** The full object, docked beside the chat (`pane`) or in a phone sheet (`sheet`). Falls back to the card. */
export function ObjectPane<R extends ObjectRef, V>({ objRef, renderers, variant = 'pane' }: { objRef: R; renderers: ObjectRenderers<R, V>; variant?: ObjectVariant }) {
  const r = useRendered(objRef, renderers);
  if (!r) return <ObjectPlaceholder objRef={objRef} />;
  return (
    <div className="kit-object-pane" data-kind={objRef.kind} data-variant={variant} data-testid="kit-object-pane">
      <LiveObject objRef={objRef} draw={(view) => (r.pane ? r.pane(objRef, view, variant) : r.card(objRef, view))} matches={r.matches} />
    </div>
  );
}

function LiveObject<R extends ObjectRef, V>({ objRef, draw, matches }: { objRef: R; draw(view: V): ReactNode; matches?(ref: R, view: V): boolean }) {
  const { view, error, loading } = useObjectEntry<V, R>(objRef);
  if (view == null || (matches && !matches(objRef, view))) return <ObjectPlaceholder objRef={objRef} error={error} loading={loading} />;
  return <>{draw(view)}</>;
}

// ── Pinned ────────────────────────────────────────────────────────────────────

/** The strip's title: the app's words for the view, else the ref's title, else its fallback text. */
export function pinnedObjectTitle<R extends ObjectRef, V>(objRef: R, view: V | null, titleOf?: (view: V, ref: R) => string | null | undefined): string {
  const t = view != null && titleOf ? titleOf(view, objRef) : null;
  return t || objRef.title || objRef.fallbackText;
}

export interface PinnedObjectProps<R extends ObjectRef, V> {
  objRef: R;
  /** Wide screens: dock it beside the chat. Phones: open it as a sheet. */
  onOpen(): void;
  /** The pane already shows this object on wide screens: pin on phones only. */
  hideOnDesktop?: boolean;
  /** The wide-screen button's words; null hides it (the page behind already is the object). */
  openLabel?: string | null;
  /** The eyebrow per kind. Default: the kind itself. */
  kindLabel?(kind: R['kind']): string;
  /** The title from the live view (e.g. a display label). Default: the ref's title or fallback. */
  titleOf?(view: V, ref: R): string | null | undefined;
  /** Beside the title at every width, e.g. a state chip. */
  state?(view: V, ref: R): ReactNode;
  /** Wide screens only, before the open button, e.g. a counts line. */
  meta?(view: V, ref: R): ReactNode;
  /** A row under the strip at every width (e.g. a review line with its action). */
  extra?(view: V, ref: R): ReactNode;
  /** The collapsible detail under the strip on wide screens (e.g. a mini board). Null: no Show / Hide. */
  detail?(view: V, ref: R): ReactNode;
  /** Detail starts open. Default true. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * The object the conversation is about, pinned at the top of the chat and
 * live. Phones: the whole strip is one button that opens the object. Wide
 * screens: `Pinned · kind`, the title, then `openLabel` and Show / Hide for
 * the detail.
 */
export function PinnedObject<R extends ObjectRef, V>({
  objRef, onOpen, hideOnDesktop = false, openLabel = 'Open beside ▸', kindLabel, titleOf, state, meta, extra, detail, defaultOpen = true, className,
}: PinnedObjectProps<R, V>) {
  const { view } = useObjectEntry<V, R>(objRef);
  const [open, setOpen] = useState(defaultOpen);
  const title = pinnedObjectTitle(objRef, view, titleOf);
  const kind = kindLabel ? kindLabel(objRef.kind) : objRef.kind;
  const chip = view != null && state ? state(view, objRef) : null;
  const metaNode = view != null && meta ? meta(view, objRef) : null;
  const extraNode = view != null && extra ? extra(view, objRef) : null;
  const detailNode = view != null && detail ? detail(view, objRef) : null;
  const hasDetail = detailNode != null && detailNode !== false;

  return (
    <section
      className={`kit-chat kit-pinned${className ? ` ${className}` : ''}`}
      data-kind={objRef.kind}
      data-hide-desktop={hideOnDesktop || undefined}
      data-testid="kit-pinned"
    >
      <div className="kit-pinned-bar">
        <button type="button" className="kit-pinned-phone" onClick={onOpen} data-testid="kit-pinned-open-sheet">
          <span className="kit-pinned-kind">{kind}</span>
          <span className="kit-pinned-title">{title}</span>
          {chip}
          <span aria-hidden="true" className="kit-pinned-go">Open ›</span>
        </button>
        <div className="kit-pinned-desk">
          <span className="kit-pinned-kind">{`Pinned · ${kind}`}</span>
          <span className="kit-pinned-title" data-testid="kit-pinned-title">{title}</span>
          {chip}
          <span className="kit-pinned-spacer" />
          {metaNode != null && <span className="kit-pinned-meta">{metaNode}</span>}
          {openLabel && (
            <button type="button" className="kit-pinned-open" onClick={onOpen} data-testid="kit-pinned-open">{openLabel}</button>
          )}
          {hasDetail && (
            <button type="button" className="kit-pinned-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)} data-testid="kit-pinned-toggle">
              {open ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      </div>
      {extraNode != null && extraNode !== false && <div className="kit-pinned-extra" data-testid="kit-pinned-extra">{extraNode}</div>}
      {hasDetail && open && <div className="kit-pinned-detail" data-testid="kit-pinned-detail">{detailNode}</div>}
    </section>
  );
}
