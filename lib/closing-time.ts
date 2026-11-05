import { localParts, zonedTime } from './domain.ts';

export function closingInstant(date: string, time: string, timezone: string): number {
  const guess = zonedTime(date, time, timezone);
  const key = (at: number) => {
    const local = localParts(new Date(at), timezone);
    return `${local.date}T${local.time}`;
  };
  const target = `${date}T${time}`;
  const matches: number[] = [];
  // A repeated clock hour closes once, at its first occurrence.
  for (let offset = -120; offset <= 120; offset += 30) {
    const candidate = guess + offset * 60000;
    if (key(candidate) === target) matches.push(candidate);
  }
  if (matches.length) return Math.min(...matches);
  // A skipped clock time closes at the first valid minute after the jump.
  for (let offset = -180; offset <= 180; offset++) {
    const candidate = guess + offset * 60000;
    const local = localParts(new Date(candidate), timezone);
    if (local.date === date && local.time >= time) return candidate;
  }
  throw Error(`No se pudo determinar el cierre ${date} ${time} en ${timezone}.`);
}
