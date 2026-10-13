/** Percentile of an ascending-sorted array; 0 when empty. */
export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}
