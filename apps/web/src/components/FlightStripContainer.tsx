'use client';

import { useRef, useState, useEffect } from 'react';
import type { MissionFlightStripData } from '@buildd/core/mission-helpers';
import { FlightStrip } from './FlightStrip';

export interface FlightStripContainerProps {
  data: MissionFlightStripData;
  className?: string;
  selectedTaskId?: string | null;
  onBarSelect?: (taskId: string) => void;
}

/** Wrapper that measures container width via ResizeObserver and passes it to
 * FlightStrip so the viewBox width always matches actual container width (1:1 scaling).
 * This keeps text readable at all viewport sizes. */
export function FlightStripContainer({
  data,
  className,
  selectedTaskId = null,
  onBarSelect,
}: FlightStripContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      const width = container.offsetWidth;
      if (width > 0) {
        setContainerWidth(width);
      }
    });

    resizeObserver.observe(container);

    // Trigger initial measurement
    const width = container.offsetWidth;
    if (width > 0) {
      setContainerWidth(width);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className={className}>
      {containerWidth !== null && (
        <FlightStrip
          data={data}
          width={containerWidth}
          selectedTaskId={selectedTaskId}
          onBarSelect={onBarSelect}
        />
      )}
    </div>
  );
}
