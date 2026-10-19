/** Health › Estimates when estimates are unavailable for this team. */
export function EstimatesOff(_props: { canManage?: boolean }) {
  return (
    <div className="py-3" data-testid="estimates-off">
      <p className="text-title font-semibold text-text-primary">Estimates are unavailable for this team.</p>
    </div>
  );
}
