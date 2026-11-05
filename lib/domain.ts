export type Role = 'admin' | 'operator' | 'viewer';
export const generalAccessId = 'general';
export type Person = {
  id: string;
  name: string;
  document: string;
  email: string;
  phone: string;
  department: string;
  kind: string;
  status: string;
  expires: string | null;
  schedule_id: string | null;
  notes: string;
  created_at: number;
  zone_ids: string[];
  credential_count: number;
  photo_path: string | null;
  /** Instante de la baja lógica. `null` en las fichas activas. */
  deleted_at: number | null;
};
export type PersonSummary = Pick<
  Person,
  | 'id'
  | 'name'
  | 'document'
  | 'phone'
  | 'department'
  | 'kind'
  | 'status'
  | 'expires'
  | 'credential_count'
  | 'photo_path'
  | 'deleted_at'
> & { zone_count: number; membership_managed?: number; sessions_remaining?: number; valid_until?: string | null };
export type PeoplePage = { rows: PersonSummary[]; total: number; page: number; pageSize: number };
export type Zone = { id: string; name: string; description: string; capacity: number; active: number; inside: number };
export type Schedule = {
  id: string;
  name: string;
  days: string;
  start: string;
  end: string;
  grace_in: number;
  grace_out: number;
};
export type ExceptionKind = 'holiday' | 'vacation' | 'leave' | 'rest';
export type CalendarException = {
  id: string;
  date: string;
  kind: ExceptionKind;
  label: string;
  person_id: string | null;
  person_name?: string | null;
};
/** Every state a person-day can be in. Order matters: it drives the monthly legend. */
export type DayStatus =
  'present' | 'late' | 'open' | 'absent' | 'rest' | 'holiday' | 'vacation' | 'leave' | 'untracked';
export type AttendanceDay = {
  person_id: string;
  name: string;
  document: string;
  department: string;
  date: string;
  status: DayStatus;
  schedule_name: string | null;
  expected_start: string | null;
  expected_end: string | null;
  expected_minutes: number;
  first: number | null;
  last: number | null;
  minutes: number;
  late_minutes: number;
  early_minutes: number;
  overtime_minutes: number;
  sessions: number;
  open: number;
  auto_closed: number;
  zones: string[];
  note: string;
};
export type AttendanceTotals = {
  worked_days: number;
  expected_days: number;
  absences: number;
  late_days: number;
  minutes: number;
  expected_minutes: number;
  late_minutes: number;
  early_minutes: number;
  overtime_minutes: number;
  open: number;
};
export type AttendancePerson = { person_id: string; name: string; document: string; department: string } & {
  totals: AttendanceTotals;
  days: Record<string, AttendanceDay>;
};
export type AttendanceReport = {
  from: string;
  to: string;
  dates: string[];
  people: AttendancePerson[];
  totals: AttendanceTotals;
  closed: boolean;
  closedMonths: string[];
};
export const statusLabels: Record<DayStatus, string> = {
  present: 'Presente',
  late: 'Tardanza',
  open: 'Sesión abierta',
  absent: 'Ausente',
  rest: 'Descanso',
  holiday: 'Feriado',
  vacation: 'Vacaciones',
  leave: 'Licencia',
  untracked: 'Sin registro',
};
export const exceptionLabels: Record<ExceptionKind, string> = {
  holiday: 'Feriado',
  vacation: 'Vacaciones',
  leave: 'Licencia',
  rest: 'Descanso',
};
/** Short marks for the monthly matrix, where a cell is a few pixels wide. */
export const statusMarks: Record<DayStatus, string> = {
  present: 'P',
  late: 'T',
  open: 'A',
  absent: 'F',
  rest: '·',
  holiday: 'H',
  vacation: 'V',
  leave: 'L',
  untracked: '–',
};
export type AccessEvent = {
  membership?: { managed: boolean; valid_until: string | null; sessions_remaining: number };
  id: number;
  person_id: string | null;
  person_name: string;
  zone_id: string;
  zone_name: string;
  direction: string;
  method: string;
  allowed: number;
  reason: string;
  detail: string;
  occurred_at: number;
  local_date: string;
  actor: string;
  photo_path?: string | null;
};
export type Credential = {
  downloadable?: number;
  id: string;
  person_id: string;
  kind: string;
  label: string;
  suffix: string;
  active: number;
  created_at: number;
};
export type Device = {
  id: string;
  name: string;
  zone_id: string;
  zone_name: string;
  kind: string;
  direction: string;
  active: number;
  last_seen: number | null;
};
export type Member = { email: string; name: string; role: Role; active: number };
export type VisitStatus = 'expected' | 'checked_in' | 'checked_out' | 'cancelled';
export type InvitationAccess = 'single' | 'reentry';
export type InvitationTheme = 'midnight' | 'minimal' | 'celebration';
export type InvitationBatch = {
  id: string;
  name: string;
  expected_date: string;
  quantity: number;
  created_at: number;
  created_by: string;
  used: number;
  pending: number;
  cancelled: number;
  inside: number;
  access_mode: InvitationAccess;
  card_theme: InvitationTheme;
  card_color: string;
  location: string;
  event_time: string;
  message: string;
  archived_at?: number | null;
  background_x?: number;
  background_y?: number;
  background_zoom?: number;
  background_ratio?: number;
  background_shade?: number;
  logo_data?: string;
};
export type InvitationTicket = {
  id: string;
  number: number;
  code: string;
  status: VisitStatus;
  used_at: number | null;
  active: number;
  guest_name: string;
  invitation_note: string;
  access_mode: InvitationAccess;
  inside?: number;
  delivery_status?: 'pending' | 'sent' | 'delivered';
};
export type Visit = {
  id: string;
  person_id: string;
  person_name: string;
  document: string;
  photo_path: string | null;
  host_name: string;
  host_email: string;
  purpose: string;
  expected_date: string;
  expected_from: string;
  expected_to: string;
  zone_id: string;
  zone_name: string;
  status: VisitStatus;
  credential_id: string | null;
  consent_at: number | null;
  checked_in_at: number | null;
  checked_out_at: number | null;
  used_at: number | null;
  blocked: number;
  guest_name: string;
  invitation_note: string;
  access_mode: InvitationAccess;
};
export type BlockedDocument = { document: string; reason: string; created_at: number; created_by: string };
export type Alert = {
  key: string;
  whatsapp?: { phone: string; text: string };
  kind: string;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  at: number;
  href?: string;
  read: boolean;
};
export type SavedReport = { id: string; name: string; kind: string; query: string; created_at: number };
export const visitStatusLabels: Record<VisitStatus, string> = {
  expected: 'Pendiente',
  checked_in: 'Dentro',
  checked_out: 'Finalizada',
  cancelled: 'Cancelada',
};
export type AttendanceRow = {
  person_id: string;
  name: string;
  date: string;
  first: number;
  last: number | null;
  minutes: number;
  sessions: number;
  open: number;
  auto_closed: number;
  zones: string[];
};
export type GymSession = {
  id: number;
  document: string;
  person_id: string;
  person_name: string;
  zone_name: string;
  local_date: string;
  entry_at: number;
  exit_at: number | null;
  auto_closed: number;
};
export type Settings = {
  name: string;
  timezone: string;
  logo_path: string | null;
  brand_color: string;
  auto_close_hours: number;
  closing_time?: string | null;
};
export type Bootstrap = {
  platform?: { gym_id: string; gym_name: string; support: boolean; superadmin: boolean; read_only: boolean };
  activation?: {
    machineId: string;
    state: 'trial' | 'active' | 'expired';
    days: number;
    trialEndsAt: number;
    activatedAt: number | null;
    licenseType: 'trial' | 'monthly' | 'permanent';
    months: number | null;
    expiresAt: number | null;
  };
  version?: string;
  installation_id: string;
  /** El usuario de la sesión es el administrador principal de la instalación. */
  owner: boolean;
  user: { id: string; name: string; email: string; role: Role };
  settings: Settings;
  zones: Zone[];
  schedules: Schedule[];
  events: AccessEvent[];
  stats: { entries: number; exits: number; denied: number; inside: number; activePeople: number };
  hourly: { hour: number; entries: number; exits: number }[];
  today: string;
  visits: {
    id: string;
    person_id: string;
    person_name: string;
    photo_path: string | null;
    expected_from: string;
    expected_to: string;
    host_name: string;
    status: VisitStatus;
  }[];
  charts: {
    occupancy: { hour: number; inside: number }[];
    zones: { name: string; entries: number }[];
    denied: { date: string; total: number; denied: number }[];
    heatmap: { day: number; hours: number[] }[];
  };
};
export const reasons: Record<string, string> = {
  OK: 'Acceso autorizado',
  UNKNOWN: 'Credencial desconocida',
  REVOKED: 'Credencial revocada',
  BLOCKED: 'Persona suspendida',
  EXPIRED: 'Permiso vencido',
  MEMBERSHIP_REQUIRED: 'Sin plan vigente para ingresar',
  SESSIONS_EXHAUSTED: 'Sesiones agotadas',
  ZONE_DISABLED: 'Zona deshabilitada',
  ZONE_DENIED: 'Sin permiso para esta zona',
  OUT_OF_SCHEDULE: 'Fuera del horario permitido',
  ALREADY_INSIDE: 'Ya tiene una entrada abierta',
  NOT_INSIDE: 'No tiene una entrada abierta',
  CAPACITY: 'Aforo completo',
  METHOD: 'Credencial incompatible con el lector',
  AUTO_CLOSE: 'Cierre automático de sesión',
  MANUAL_CORRECTION: 'Corrección administrativa',
  BLOCKLIST: 'Documento en lista de bloqueo',
  INVITATION_DATE: 'Invitación válida únicamente en la fecha indicada',
  INVITATION_USED: 'Invitación ya utilizada',
  INVITATION_CLOSED: 'Invitación cancelada o finalizada',
};
export const kindLabels: Record<string, string> = {
  employee: 'Personal',
  visitor: 'Visitante',
  member: 'Miembro',
  qr: 'QR',
  nfc: 'NFC',
  biometric: 'Biometría externa',
  manual: 'Registro manual',
  system: 'Automático',
};
export const roleLabels: Record<string, string> = { admin: 'Administrador', operator: 'Cajero', viewer: 'Consulta' };
export function searchFold(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
}
export function localParts(date: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    hour: Number(parts.hour),
  };
}
/**
 * The instant at which a wall-clock date and time occurs in a timezone. Converges in two passes
 * because the offset itself depends on the instant; a third guards against a DST change landing
 * exactly on the shift boundary.
 */
export function zonedTime(date: string, time: string, timezone: string) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let pass = 0; pass < 3; pass++) {
    const parts = localParts(new Date(guess), timezone);
    const drift = target - Date.parse(`${parts.date}T${parts.time}:00Z`);
    if (!drift) break;
    guess += drift;
  }
  return guess;
}
/** The date that follows `date`, as a plain YYYY-MM-DD string. */
export function nextDate(date: string, days = 1) {
  return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function eachDate(from: string, to: string) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = nextDate(date)) dates.push(date);
  return dates;
}
export function withinSchedule(days: number[], start: string, end: string, time: string, day: number) {
  if (start === end) return days.includes(day);
  if (start < end) return days.includes(day) && time >= start && time < end;
  return (days.includes(day) && time >= start) || (days.includes((day + 6) % 7) && time < end);
}
export function csvCell(value: unknown) {
  const s = String(value ?? '');
  return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : '') + s.replaceAll('"', '""') + '"';
}
