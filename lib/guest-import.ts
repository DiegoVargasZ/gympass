import type { InvitationAccess } from './domain.ts';
export type ImportedGuest = { guest_name: string; invitation_note: string; access_mode?: InvitationAccess };
export function parseGuestCsv(source: string): string[][] {
  const text = source.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0],
    delimiter = (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || cell === '') quoted = !quoted;
      else throw Error('Hay comillas mal colocadas en el CSV.');
    } else if (!quoted && char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
    if (rows.length > 1001 || row.length > 50 || cell.length > 10000)
      throw Error('La lista supera los límites: 1.000 invitados y 50 columnas.');
  }
  if (quoted) throw Error('Falta cerrar una celda entre comillas en el CSV.');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
const fold = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
export function guestColumnDefaults(rows: unknown[][]) {
  const first = rows[0] || [];
  const find = (labels: string[]) => first.findIndex((value) => labels.includes(fold(value)));
  const name = find(['nombre', 'nombre completo', 'name', 'invitado', 'guest_name']);
  return {
    header: name >= 0,
    name: Math.max(0, name),
    note: find(['mensaje', 'nota', 'message', 'invitation_note']),
    access: find(['acceso', 'tipo de acceso', 'access_mode']),
  };
}
export function mapGuestRows(
  rows: unknown[][],
  columns: { header: boolean; name: number; note: number; access: number },
) {
  const guests: ImportedGuest[] = [],
    errors: string[] = [];
  const source = rows.slice(columns.header ? 1 : 0);
  source.forEach((row, index) => {
    if (!row.some((value) => String(value ?? '').trim())) return;
    const guest_name = String(row[columns.name] ?? '').trim(),
      invitation_note = columns.note < 0 ? '' : String(row[columns.note] ?? '').trim();
    const raw = columns.access < 0 ? '' : fold(row[columns.access]);
    const access_mode: InvitationAccess | undefined = !raw
      ? undefined
      : ['reentry', 'entradas y salidas', 'multiple', 'varias', 'reingreso'].includes(raw)
        ? 'reentry'
        : ['single', 'un ingreso', 'una entrada', 'un solo ingreso'].includes(raw)
          ? 'single'
          : undefined;
    const line = index + (columns.header ? 2 : 1);
    if (!guest_name || guest_name.length > 100)
      errors.push(`Fila ${line}: el nombre debe tener de 1 a 100 caracteres.`);
    if (invitation_note.length > 140) errors.push(`Fila ${line}: el mensaje supera 140 caracteres.`);
    if (raw && !access_mode) errors.push(`Fila ${line}: acceso desconocido. Usa single o reentry.`);
    guests.push({ guest_name, invitation_note, ...(access_mode ? { access_mode } : {}) });
  });
  if (guests.length > 1000) errors.push('Puedes importar hasta 1.000 invitados por vez.');
  if (!guests.length) errors.push('El archivo no contiene invitados.');
  return { guests, errors };
}
