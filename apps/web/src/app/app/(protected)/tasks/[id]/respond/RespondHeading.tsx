/**
 * The respond page's title block: the kind/scope eyebrow on its own line, then
 * the title. The eyebrow is a block, never an inline run-in inside the h1 —
 * on a phone an inline eyebrow wraps straight into the title's first words.
 */
export default function RespondHeading({ eyebrow, heading }: { eyebrow: readonly string[]; heading: string }) {
  return (
    <div className="mt-3">
      {eyebrow.length > 0 && (
        <p data-testid="respond-eyebrow" className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted">{eyebrow.join(' · ')}</p>
      )}
      <h1 className={`${eyebrow.length > 0 ? 'mt-1 ' : ''}text-[20px] font-semibold text-text-primary leading-snug`}>{heading}</h1>
    </div>
  );
}
