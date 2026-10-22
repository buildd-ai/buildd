/**
 * Select a strip cell the way the arrow keys do. A tap on a cell opens its
 * task page (spec d25d923d R-1), so a fixture that lands on a selection steps
 * to it from a neighbour instead of clicking it.
 */
export function selectStripCell(cells: readonly HTMLButtonElement[], index: number): void {
  if (index < 0 || index >= cells.length) return;
  if (cells.length === 1) return;
  const from = index > 0 ? cells[index - 1] : cells[1];
  from.focus();
  from.dispatchEvent(new KeyboardEvent('keydown', { key: index > 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
}
