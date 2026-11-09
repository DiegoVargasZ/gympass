export function durationLabel(entry: number, exit: number | null, now: number) {
  const minutes = Math.max(0, Math.floor(((exit ?? now) - entry) / 60000));
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
