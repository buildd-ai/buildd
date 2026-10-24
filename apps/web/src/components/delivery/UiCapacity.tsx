'use client';

import { useState } from 'react';

export type CapacityWindow = '24h' | '7d' | '30d';

interface UiCapacityProps {
  running: number;
  total: number;
  runnersOnline: number;
  totalRunners: number;
  sessions: number;
  peak: number;
  average: number;
  chart: number[];
  window?: CapacityWindow;
  onWindowChange?: (window: CapacityWindow) => void;
}

export default function UiCapacity({
  running,
  total,
  runnersOnline,
  totalRunners,
  sessions,
  peak,
  average,
  chart,
  window = '24h',
  onWindowChange,
}: UiCapacityProps) {
  const [currentWindow, setCurrentWindow] = useState<CapacityWindow>(window);

  const handleWindowClick = (w: CapacityWindow) => {
    setCurrentWindow(w);
    onWindowChange?.(w);
  };

  const maxChartValue = Math.max(...chart, 1);

  return (
    <div
      style={{
        fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
        color: '#26231F',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '26px',
                fontWeight: '600',
                lineHeight: '1.1',
              }}
            >
              {running}/{total}
            </span>
            <span style={{ fontSize: '12px', color: '#6B655C' }}>Running</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '18px',
                fontWeight: '600',
                lineHeight: '1.1',
              }}
            >
              {runnersOnline}/{totalRunners}
            </span>
            <span style={{ fontSize: '12px', color: '#6B655C' }}>Runners</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '18px',
                fontWeight: '600',
                lineHeight: '1.1',
              }}
            >
              {sessions}
            </span>
            <span style={{ fontSize: '12px', color: '#6B655C' }}>Sessions</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '18px',
                fontWeight: '600',
                lineHeight: '1.1',
              }}
            >
              {peak}
            </span>
            <span style={{ fontSize: '12px', color: '#6B655C' }}>Peak</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '18px',
                fontWeight: '600',
                lineHeight: '1.1',
              }}
            >
              {average}
            </span>
            <span style={{ fontSize: '12px', color: '#6B655C' }}>Avg</span>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '2px',
            padding: '2px',
            background: '#EEEBE4',
            borderRadius: '6px',
            width: '150px',
          }}
        >
          {(['24h', '7d', '30d'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => handleWindowClick(w)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                minHeight: '30px',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '13px',
                background: currentWindow === w ? '#FDFCF9' : 'transparent',
                color: currentWindow === w ? '#26231F' : '#6B655C',
                fontWeight: currentWindow === w ? '600' : '400',
                boxShadow: currentWindow === w ? '0 1px 2px rgba(38,35,31,.08)' : 'none',
              }}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${chart.length}, minmax(0, 1fr))`,
          gap: '2px',
          alignItems: 'end',
          height: '48px',
          borderBottom: '1px solid #DCD6CC',
        }}
      >
        {chart.map((value, i) => {
          const percent = value / maxChartValue;
          const isIdle = percent < 0.5;

          return (
            <span
              key={i}
              style={{
                display: 'block',
                borderRadius: '1px 1px 0 0',
                background: isIdle ? '#EAD9C8' : '#B9B2A6',
                height: `${Math.max(percent * 100, 4)}%`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
