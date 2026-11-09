import type { GymSession } from './domain.ts';
import { searchFold } from './domain.ts';
import { toCsv } from './csv.ts';

export type GymSessionState = 'all' | 'open' | 'closed';
export type GymSessionFilters = { from?: string; to?: string; person?: string; q?: string; state?: GymSessionState };
export type GymMemberHours = {
  person_id: string;
  person_name: string;
  document: string;
  completed_ms: number;
  completed_visits: number;
  completed_days: number;
  average_visit_ms: number | null;
  average_day_ms: number | null;
  open_visits: number;
  estimated_visits: number;
  estimated_ms: number;
};

export function filterGymSessions(rows: readonly GymSession[], filters: GymSessionFilters): GymSession[] {
  const query = searchFold(filters.q?.trim() || '');
  return rows.filter(
    (row) =>
      (!filters.from || row.local_date >= filters.from) &&
      (!filters.to || row.local_date <= filters.to) &&
      (!filters.person || row.person_id === filters.person) &&
      (searchFold(row.person_name).includes(query) || searchFold(row.document).includes(query)) &&
      (!filters.state ||
        filters.state === 'all' ||
        (filters.state === 'open' ? row.exit_at === null : row.exit_at !== null)),
  );
}

export function summarizeGymSessions(rows: readonly GymSession[]): GymMemberHours[] {
  const groups = new Map<string, { summary: GymMemberHours; days: Set<string>; latest: number }>();
  for (const row of rows) {
    let group = groups.get(row.person_id);
    if (!group) {
      group = {
        summary: {
          person_id: row.person_id,
          person_name: row.person_name,
          document: row.document,
          completed_ms: 0,
          completed_visits: 0,
          completed_days: 0,
          average_visit_ms: null,
          average_day_ms: null,
          open_visits: 0,
          estimated_visits: 0,
          estimated_ms: 0,
        },
        days: new Set(),
        latest: row.entry_at,
      };
      groups.set(row.person_id, group);
    }
    const summary = group.summary;
    if (row.entry_at > group.latest) {
      summary.person_name = row.person_name;
      summary.document = row.document;
      group.latest = row.entry_at;
    }
    if (row.exit_at === null) {
      summary.open_visits++;
      continue;
    }
    const duration = Math.max(0, row.exit_at - row.entry_at);
    summary.completed_ms += duration;
    summary.completed_visits++;
    group.days.add(row.local_date);
    if (row.auto_closed) {
      summary.estimated_visits++;
      summary.estimated_ms += duration;
    }
  }
  return [...groups.values()]
    .map(({ summary, days }) => ({
      ...summary,
      completed_days: days.size,
      average_visit_ms: summary.completed_visits ? summary.completed_ms / summary.completed_visits : null,
      average_day_ms: days.size ? summary.completed_ms / days.size : null,
    }))
    .sort(
      (a, b) =>
        a.person_name.localeCompare(b.person_name, 'es', { sensitivity: 'base' }) ||
        a.document.localeCompare(b.document, 'es') ||
        a.person_id.localeCompare(b.person_id),
    );
}

export function gymSummaryCsv(
  summaries: readonly GymMemberHours[],
  period: { from: string; to: string; timezone: string },
): string {
  const hours = (ms: number | null) => (ms === null ? '' : Number((ms / 3600000).toFixed(4)));
  return toCsv(
    [
      'Socio',
      'Documento',
      'Desde',
      'Hasta',
      'Zona horaria',
      'Visitas finalizadas',
      'Días con visitas finalizadas',
      'Total horas finalizadas',
      'Promedio horas por visita',
      'Promedio horas por día de asistencia',
      'Visitas con cierre estimado',
      'Horas estimadas incluidas',
      'Visitas abiertas (sin sumar)',
    ],
    summaries.map((row) => [
      row.person_name,
      row.document,
      period.from,
      period.to,
      period.timezone,
      row.completed_visits,
      row.completed_days,
      hours(row.completed_ms),
      hours(row.average_visit_ms),
      hours(row.average_day_ms),
      row.estimated_visits,
      hours(row.estimated_ms),
      row.open_visits,
    ]),
  );
}
