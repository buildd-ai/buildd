'use client';

/**
 * A page body that follows live events without a page render (spec 3ef37387
 * R-16). The server renders `children` once; a live event asks the region's
 * refresher (through `requestPageRefresh`, so one per 5 s per tab), which calls
 * `load`, a server action that renders the same body, and swaps it in. No
 * router refresh: the layout is not re-requested and the router cache is left
 * alone. Only the layout is skipped: the body's own reads all run again. A page
 * whose live part is small uses `LiveData` below instead (the task page).
 *
 * Surfaces inside the body get the refresher from `useRegionRefresher(router)`
 * and ask it where they used to ask the router. A render the page takes any
 * other way (a pull, a resume) arrives as new `children` and wins over a read
 * still in flight. A read that cannot answer falls back to `router.refresh()`.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Refresher } from '@/lib/page-refresh';
import { createRegionReader } from '@/lib/region-reader';

const RegionRefresherContext = createContext<Refresher | null>(null);

/** The enclosing region's refresher, or `fallback` (the router) outside one. */
export function useRegionRefresher<T extends Refresher>(fallback: T): Refresher {
  return useContext(RegionRefresherContext) ?? fallback;
}

const RegionValueContext = createContext<unknown>(null);

/** The enclosing `LiveData`'s latest read, or null before one (and outside one). */
export function useRegionValue<T>(): T | null {
  return useContext(RegionValueContext) as T | null;
}

/**
 * A page region that follows live events by re-reading *data* (a server action
 * that reads only that region's rows), not by re-rendering markup. `children`
 * stay as the server rendered them; the surfaces that show the region read it
 * with `useRegionValue` and ask for a read with `useRegionRefresher`. A read
 * that returns null (the page's other parts need to change) falls back to one
 * page refresh, as does a failed read.
 */
export function LiveData<T>({ initial, load, children }: { initial: T; load: () => Promise<T | null>; children: ReactNode }) {
  const router = useRouter();
  const [value, setValue] = useState<T>(initial);
  const latest = useRef({ load, router });
  latest.current = { load, router };

  const reader = useMemo(() => createRegionReader<T>({
    load: () => latest.current.load(),
    apply: setValue,
    fallback: () => latest.current.router.refresh(),
  }), []);

  // A page render (pull, resume, a fallback refresh) carries newer state than a read in flight.
  const seen = useRef(initial);
  useEffect(() => {
    if (seen.current === initial) return;
    seen.current = initial;
    reader.supersede();
    setValue(initial);
  }, [initial, reader]);

  return (
    <RegionRefresherContext.Provider value={reader.refresher}>
      <RegionValueContext.Provider value={value}>{children}</RegionValueContext.Provider>
    </RegionRefresherContext.Provider>
  );
}

export function LiveRegion({ load, children }: { load: () => Promise<ReactNode>; children: ReactNode }) {
  const router = useRouter();
  const [node, setNode] = useState<ReactNode>(children);
  const latest = useRef({ load, router });
  latest.current = { load, router };

  const reader = useMemo(() => createRegionReader<ReactNode>({
    load: () => latest.current.load(),
    apply: setNode,
    fallback: () => latest.current.router.refresh(),
  }), []);

  // A page render (pull, resume, navigation) carries newer state than a read in flight.
  const seen = useRef(children);
  useEffect(() => {
    if (seen.current === children) return;
    seen.current = children;
    reader.supersede();
    setNode(children);
  }, [children, reader]);

  return <RegionRefresherContext.Provider value={reader.refresher}>{node}</RegionRefresherContext.Provider>;
}
