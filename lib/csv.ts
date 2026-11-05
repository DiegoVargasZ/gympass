import { csvCell } from './domain.ts';
export function toCsv(headers: string[], rows: unknown[][]) {
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
