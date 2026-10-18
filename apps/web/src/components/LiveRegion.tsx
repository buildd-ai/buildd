'use client';

/**
 * A page body that follows live events without a page render (spec 3ef37387
 * R-16). The server renders `children` once; a live event asks the region's
 * refresher (through `requestPageRefresh`, so one per 5 s per tab), which calls
 * `load`, a server action that renders the same body, and swaps it in. No
 * router refresh: the layout is not re-requested and the router cache is left
 * alone.
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
