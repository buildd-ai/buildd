'use client';

/**
 * Home's body with its live region (spec 3ef37387 R-16): the action queue, the
 * moving missions and the counts line follow Pusher events through `load` (a
 * server action reading just that region) instead of re-rendering the page.
 * The server-rendered cards around them (Agents, Landed, chat, setup) stay as
 * rendered until the next page render.
 */
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { createRegionReader } from '@/lib/region-reader';
import HomeAutoRefresh from './HomeAutoRefresh';
import { HomeBody } from './HomeBody';

type BodyProps = ComponentProps<typeof HomeBody>;

/** What a live event re-reads: everything HomeBody takes as data. */
export type HomeRegion = Pick<BodyProps, 'items' | 'counts' | 'milestones' | 'quietMissions' | 'quietCauses' | 'inProgress'>;

export default function HomeLive({ region: initial, load, workspaceIds, ...rest }: Omit<BodyProps, keyof HomeRegion> & {
  region: HomeRegion;
  /** Null when the viewer is gone or the read failed: the page refreshes instead. */
  load: () => Promise<HomeRegion | null>;
  workspaceIds: string[];
}) {
  const router = useRouter();
  const [region, setRegion] = useState(initial);
  const latest = useRef({ load, router });
  latest.current = { load, router };
  const reader = useMemo(() => createRegionReader<HomeRegion>({
    load: () => latest.current.load(),
    apply: setRegion,
    fallback: () => latest.current.router.refresh(),
  }), []);

  // A page render (pull, resume, filter change) carries newer state than a read in flight.
  const seen = useRef(initial);
  useEffect(() => {
    if (seen.current === initial) return;
    seen.current = initial;
    reader.supersede();
    setRegion(initial);
  }, [initial, reader]);

  return (
    <>
      <HomeAutoRefresh workspaceIds={workspaceIds} refresher={reader.refresher} />
      <div className="mx-auto max-w-[1320px]">
        <HomeBody {...rest} {...region} />
      </div>
    </>
  );
}
