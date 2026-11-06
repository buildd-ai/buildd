/**
 * The decision the revision's author needs from the reader, one sentence. It
 * leads the inbox row and the confirm page, above the coverage line; the
 * author wrote it, nothing here is generated.
 */
export default function SpecQuestion({ question }: { question: string }) {
  return (
    <p className="border-l-2 border-accent-text pl-3 text-lede font-semibold text-text-primary [overflow-wrap:anywhere]" data-testid="spec-question">
      <span className="sr-only">Decision needed: </span>{question}
    </p>
  );
}
