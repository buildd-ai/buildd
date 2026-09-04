const BAR_COUNT = 5;

const SIZE_CLASSES = {
  // For small inline indicators (status dots, "· syncing" text runs).
  xs: { bar: 'w-[2px] h-[8px]', gap: 'gap-[1px]' },
  // For button-height use (loading state on an action button).
  sm: { bar: 'w-[4px] h-[12px]', gap: 'gap-[2px]' },
  // Default — standalone panel/dialog loading state.
  md: { bar: 'w-[9px] h-[22px]', gap: 'gap-[5px]' },
} as const;

type SpinnerSize = keyof typeof SIZE_CLASSES;

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  'aria-label'?: string;
}

export default function Spinner({ size = 'md', className = '', 'aria-label': ariaLabel = 'Loading' }: SpinnerProps) {
  const { bar, gap } = SIZE_CLASSES[size];

  return (
    <span role="status" aria-label={ariaLabel} className={`inline-flex items-end ${gap} ${className}`}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span key={i} className={`spinner-bar ${bar}`} style={{ animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  );
}
