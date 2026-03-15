export default function MissionsPage() {
  return (
    <div className="px-7 md:px-10 pt-5 md:pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">Missions</h1>
        <span className="text-xs text-text-secondary font-light">0 active</span>
      </div>

      {/* Empty state */}
      <div className="card p-8 text-center">
        <p className="text-sm text-text-secondary mb-1">No missions yet.</p>
        <p className="text-xs text-text-muted">
          Missions are goals you assign to your agents — build features, watch for signals, or produce findings.
        </p>
      </div>
    </div>
  );
}
