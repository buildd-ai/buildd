'use client';

interface UiIdleAlertProps {
  idleSlots: number;
  queuedTasks: number;
  cause: string;
  href?: string;
}

export default function UiIdleAlert({
  idleSlots,
  queuedTasks,
  cause,
  href = '#',
}: UiIdleAlertProps) {
  if (idleSlots <= 0) {
    return null;
  }

  return (
    <a
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        minHeight: '40px',
        padding: '0 12px',
        boxSizing: 'border-box',
        width: '100%',
        background: '#FBF1E8',
        borderRadius: '6px',
        textDecoration: 'none',
        color: '#7F3C11',
        fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
        fontSize: '13.5px',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: '600',
        }}
      >
        !
      </span>
      <span style={{ fontWeight: '600', whiteSpace: 'nowrap' }}>
        {idleSlots} idle · {queuedTasks} queued
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          padding: '1px 7px',
          borderRadius: '4px',
          background: '#F3DFCC',
          color: '#7F3C11',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {cause}
      </span>
      <span style={{ marginLeft: 'auto' }}>›</span>
    </a>
  );
}
