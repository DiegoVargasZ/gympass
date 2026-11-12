import { z } from 'zod';
import { remainingDays, renewalMessage } from './renewals.ts';
import { closingInstant } from './closing-time.ts';
import type { Database } from './database.ts';
import {
  generalAccessId,
  localParts,
  zonedTime,
  nextDate,
  eachDate,
  withinSchedule,
  searchFold,
  type Role,
  type Person,
  type PersonSummary,
  type AttendanceRow,
  type GymSession,
  type AttendanceDay,
  type AttendancePerson,
  type AttendanceReport,
  type AttendanceTotals,
  type DayStatus,
} from './domain.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type Actor = { id: string; email: string; name: string; role: Role };
export type CredentialCodec = {
  seal: (code: string, id: string) => string;
  open: (value: string, id: string) => string;
};
type Row = Record<string, any>;
const text = z.string().trim().min(1).max(120);
const email = z.union([z.string().trim().email().max(200), z.literal('')]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Fecha inválida');
/** WhatsApp needs digits only with the country code; we normalise and never store punctuation. */
const phone = z
  .string()
  .trim()
  .max(24)
  .transform((value) => value.replace(/[^\d]/g, ''))
  .refine((value) => value === '' || (value.length >= 8 && value.length <= 15), 'Teléfono inválido')
  .default('');
export const personSchema = z.object({
  name: text,
  document: text,
  email: email.default(''),
  phone,
  department: z.string().trim().max(100).default(''),
  kind: z.enum(['employee', 'visitor', 'member']),
  status: z.enum(['active', 'blocked']),
  expires: date.nullable().default(null),
  schedule_id: text.nullable().default(null),
  notes: z.string().trim().max(1000).default(''),
  zone_ids: z.array(text).min(1).max(50).default([generalAccessId]),
});
const scheduleSchema = z.object({
  name: text,
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  grace_in: z.number().int().min(0).max(240).default(10),
  grace_out: z.number().int().min(0).max(240).default(10),
});
const exceptionSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, 'Fecha inválida'),
  kind: z.enum(['holiday', 'vacation', 'leave', 'rest']),
  label: text,
  person_id: text.nullable().default(null),
});
const emptyTotals = (): AttendanceTotals => ({
  worked_days: 0,
  expected_days: 0,
  absences: 0,
  late_days: 0,
  minutes: 0,
  expected_minutes: 0,
  late_minutes: 0,
  early_minutes: 0,
  overtime_minutes: 0,
  open: 0,
});
/** Conserva la vigencia de una ficha antigua hasta que empiece su primer plan comprado. */
export function legacyCoverageSql(today: string) {
  date.parse(today);
  return `(p.legacy_access=1 AND p.expires IS NOT NULL AND p.expires>='${today}' AND NOT EXISTS(
    SELECT 1 FROM pos_memberships old WHERE old.person_id=p.id AND old.start_date<='${today}'))`;
}
/** The people table with membership-aware `expires`. Fichas dadas de baja quedan fuera salvo que se pidan. */
function effectivePeopleSql(today: string, includeDeleted = false) {
  date.parse(today);
  return `(SELECT p.id,p.name,p.document,p.email,p.phone,p.department,p.kind,p.status,p.schedule_id,p.notes,p.created_at,p.photo_path,p.deleted_at,
    p.expires legacy_expires,
    CASE WHEN p.kind='member' AND NOT ${legacyCoverageSql(today)} AND (p.legacy_access=0 OR EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id)) THEN 1 ELSE 0 END membership_managed,
    COALESCE((SELECT SUM(m.sessions_remaining) FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.unit='sessions' AND m.start_date<='${today}'),0) sessions_remaining,
    (SELECT MAX(date(m.end_date,'-1 day')) FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.unit<>'sessions' AND m.start_date<='${today}' AND m.end_date>'${today}') valid_until,
    CASE WHEN p.kind='member' AND NOT ${legacyCoverageSql(today)} AND (p.legacy_access=0 OR EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id)) THEN
      CASE WHEN EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.unit='sessions' AND m.start_date<='${today}' AND m.sessions_remaining>0) THEN NULL
      ELSE COALESCE((SELECT MAX(date(m.end_date,'-1 day')) FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.unit<>'sessions' AND m.start_date<='${today}'),date('${today}','-1 day')) END
    ELSE p.expires END expires
    FROM people p${includeDeleted ? '' : ' WHERE p.deleted_at IS NULL'})`;
}
const peopleSummarySql = (
  today: string,
  includeDeleted = false,
) => `SELECT p.id,p.name,p.document,p.phone,p.department,p.kind,p.status,p.expires,p.photo_path,p.deleted_at,
  p.membership_managed,p.sessions_remaining,p.valid_until,
  (SELECT COUNT(*) FROM credentials c WHERE c.person_id=p.id AND c.active=1) credential_count,
  (SELECT COUNT(*) FROM person_zones z WHERE z.person_id=p.id) zone_count FROM ${effectivePeopleSql(today, includeDeleted)} p`;
/**
 * Quien sigue dentro: el ultimo evento permitido de cada par (persona,zona) es una entrada.
 * Parte de los pares distintos y pide a cada uno su ultimo evento, en vez de recorrer todas
 * las entradas historicas; asi el costo lo fija el numero de socios y no el tamano del historial.
 * Un evento permitido sin persona nunca tuvo un posterior que lo cerrara, igual que antes.
 */
export const presenceSql = `SELECT e.* FROM events e WHERE e.allowed=1 AND e.direction='entry' AND (e.person_id IS NULL OR e.id IN (
  SELECT (SELECT l.id FROM events l WHERE l.person_id=k.person_id AND l.zone_id=k.zone_id AND l.allowed=1
          ORDER BY l.occurred_at DESC, l.id DESC LIMIT 1)
  FROM (SELECT DISTINCT person_id, zone_id FROM events WHERE allowed=1 AND person_id IS NOT NULL) k))`;
export const randomToken = (prefix: string) =>
  prefix +
  '_' +
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
let hashImplementation: ((value: string) => Promise<string>) | undefined;
export function setHashImplementation(implementation: (value: string) => Promise<string>) { hashImplementation = implementation; }
export async function hash(value: string) {
  if (hashImplementation) return hashImplementation(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
/** El QR personal no incluye invitaciones ni se reemplaza al renovar planes. */
export const personalQrIdSql = `SELECT c.id FROM credentials c WHERE c.person_id=? AND c.kind='qr' AND c.active=1
  AND NOT EXISTS(SELECT 1 FROM visits v WHERE v.credential_id=c.id) ORDER BY c.created_at DESC,c.id DESC LIMIT 1`;
export class Service {
  db: Database;
  actor: Actor;
  codec?: CredentialCodec;
  constructor(db: Database, actor: Actor, codec?: CredentialCodec) {
    this.db = db;
    this.actor = actor;
    this.codec = codec;
  }
  stmt(sql: string, ...args: any[]) {
    return this.db.prepare(sql).bind(...args);
  }
  async all(sql: string, ...args: any[]): Promise<Row[]> {
    return (await this.stmt(sql, ...args).all<Row>()).results;
  }
  async one(sql: string, ...args: any[]): Promise<Row | null> {
    return this.stmt(sql, ...args).first<Row>();
  }
  require(role: 'admin' | 'operator') {
    if (this.actor.role === 'viewer' || (role === 'admin' && this.actor.role !== 'admin'))
      throw new ApiError(403, 'Tu rol no permite esta acción.');
  }
  requireReports() {
    if (!['admin', 'viewer'].includes(this.actor.role)) throw new ApiError(403, 'Tu rol no permite consultar ni exportar informes.');
  }
  audit(action: string, id: string) {
    return this.stmt(
      'INSERT INTO audit(actor,action,entity_id,occurred_at) VALUES(?,?,?,?)',
      this.actor.email,
      action,
      id,
      Date.now(),
    );
  }
  async exists(table: string, id: string) {
    if (!(await this.one(`SELECT id FROM ${table} WHERE id=?`, id))) throw new ApiError(404, 'Registro no encontrado.');
  }
  async bootstrap(options: { compact?: boolean; maintain?: boolean } = {}) {
    if (options.maintain) {
      await new Service(this.db, { id: 'system', email: 'system', name: 'Sistema', role: 'admin' }, this.codec)
        .closeStaleSessions();
    }
    const installation = await this.one('SELECT owner FROM settings WHERE id=1');
    const [settings, zones, schedules, events, presence] = await Promise.all([
      this.one('SELECT name,timezone,logo_path,logo_watermark_size,credential_color,credential_watermark_size,brand_color,auto_close_hours,closing_time FROM settings WHERE id=1'),
      this.all(
        `SELECT z.*, (SELECT COUNT(*) FROM (${presenceSql}) p WHERE p.zone_id=z.id) inside FROM zones z ORDER BY z.name`,
      ),
      this.all('SELECT * FROM schedules ORDER BY name'),
      this.all(
        'SELECT e.*,p.photo_path FROM events e LEFT JOIN people p ON p.id=e.person_id ORDER BY e.occurred_at DESC,e.id DESC LIMIT 12',
      ),
      this.one(`SELECT COUNT(*) total FROM (${presenceSql})`),
    ]);
    const today = localParts(new Date(), settings!.timezone).date;
    const activePeople = await this.one(
      `SELECT COUNT(*) total FROM ${effectivePeopleSql(today)} WHERE status='active' AND (expires IS NULL OR expires>=?)`,
      today,
    );
    if (options.compact) {
      const counts = await this.one(
        `SELECT COALESCE(SUM(allowed=1 AND direction='entry'),0) entries,
         COALESCE(SUM(allowed=1 AND direction='exit'),0) exits,
         COALESCE(SUM(allowed=0),0) denied FROM events WHERE local_date=?`,
        today,
      );
      return {
        installation_id: await hash(installation!.owner),
        owner: installation!.owner === this.actor.id,
        user: { id: this.actor.id, name: this.actor.name, email: this.actor.email, role: this.actor.role },
        settings,
        zones,
        schedules,
        events,
        today,
        hourly: [],
        visits: [],
        charts: { occupancy: [], zones: [], denied: [], heatmap: [] },
        stats: {
          entries: counts!.entries,
          exits: counts!.exits,
          denied: counts!.denied,
          inside: presence!.total,
          activePeople: activePeople!.total,
        },
      };
    }
    const dayEvents = await this.all('SELECT direction,allowed,occurred_at FROM events WHERE local_date=?', today);
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, entries: 0, exits: 0 }));
    for (const e of dayEvents)
      if (e.allowed)
        hourly[localParts(new Date(e.occurred_at), settings!.timezone).hour][
          e.direction === 'entry' ? 'entries' : 'exits'
        ]++;
    let occupancy = Math.max(
      0,
      presence!.total -
        dayEvents.reduce((net, event) => net + (event.allowed ? (event.direction === 'entry' ? 1 : -1) : 0), 0),
    );
    const currentParts = localParts(new Date(), settings!.timezone);
    const currentHour = currentParts.hour;
    const occupancyByHour = [{ hour: 0, inside: occupancy }];
    for (const hour of hourly.filter((item) => item.hour <= currentHour)) {
      occupancy = Math.max(0, occupancy + hour.entries - hour.exits);
      occupancyByHour.push({
        hour: hour.hour < currentHour ? hour.hour + 1 : currentHour + Number(currentParts.time.slice(3)) / 60,
        inside: occupancy,
      });
    }
    const dates = Array.from({ length: 7 }, (_, index) =>
      new Date(Date.parse(today + 'T12:00:00Z') - (6 - index) * 86400000).toISOString().slice(0, 10),
    );
    const [topZones, deniedDays, expectedVisits, heatmapRows] = await Promise.all([
      this.all(
        "SELECT zone_name name,COUNT(*) entries FROM events WHERE local_date=? AND allowed=1 AND direction='entry' GROUP BY zone_id ORDER BY entries DESC,zone_name LIMIT 5",
        today,
      ),
      this.all(
        "SELECT local_date date,COUNT(*) total,SUM(CASE WHEN allowed=0 THEN 1 ELSE 0 END) denied FROM events WHERE local_date BETWEEN ? AND ? AND method<>'system' GROUP BY local_date",
        dates[0],
        today,
      ),
      this.all(
        `SELECT v.id,v.expected_from,v.expected_to,v.host_name,v.status,p.name person_name,p.photo_path,p.id person_id
         FROM visits v JOIN people p ON p.id=v.person_id
         WHERE v.expected_date=? AND v.status IN('expected','checked_in')
         ORDER BY v.expected_from LIMIT 10`,
        today,
      ),
      // Four weeks of authorized entries, bucketed by local weekday and hour.
      this.all(
        "SELECT occurred_at FROM events WHERE allowed=1 AND direction='entry' AND method<>'system' AND local_date BETWEEN ? AND ?",
        nextDate(today, -27),
        today,
      ),
    ]);
    const heatmap = Array.from({ length: 7 }, (_, day) => ({ day, hours: Array.from({ length: 24 }, () => 0) }));
    for (const row of heatmapRows) {
      const parts = localParts(new Date(row.occurred_at), settings!.timezone);
      heatmap[parts.day].hours[parts.hour]++;
    }
    return {
      installation_id: await hash(installation!.owner),
      // Administrador principal de la instalación: el único que administra la activación.
      owner: installation!.owner === this.actor.id,
      user: { id: this.actor.id, name: this.actor.name, email: this.actor.email, role: this.actor.role },
      settings,
      zones,
      schedules,
      events,
      today,
      hourly,
      visits: expectedVisits,
      charts: {
        occupancy: occupancyByHour,
        zones: topZones,
        denied: dates.map((date) => deniedDays.find((day) => day.date === date) || { date, total: 0, denied: 0 }),
        heatmap,
      },
      stats: {
        entries: dayEvents.filter((e) => e.allowed && e.direction === 'entry').length,
        exits: dayEvents.filter((e) => e.allowed && e.direction === 'exit').length,
        denied: dayEvents.filter((e) => !e.allowed).length,
        inside: presence!.total,
        activePeople: activePeople!.total,
      },
    };
  }
  async peopleList(params: URLSearchParams) {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings?.timezone || 'America/La_Paz').date;
    const query = z
      .object({
        q: z.string().trim().max(120),
        kind: z.enum(['', 'employee', 'visitor', 'member']),
        state: z.enum(['', 'deleted']),
        page: z.coerce.number().int().min(1).max(1000000),
        limit: z.coerce.number().int().min(1).max(50),
      })
      .parse({
        q: params.get('q') || '',
        kind: params.get('kind') || '',
        state: params.get('state') || '',
        page: params.get('page') ?? 1,
        limit: params.get('limit') ?? 50,
      });
    const deleted = query.state === 'deleted';
    const conditions: string[] = [],
      args: string[] = [];
    if (query.q) {
      const pattern = '%' + searchFold(query.q).replace(/[\\%_]/g, (character) => '\\' + character) + '%';
      conditions.push(
        "(search_fold(p.name) LIKE ? ESCAPE '\\' OR search_fold(p.document) LIKE ? ESCAPE '\\' OR search_fold(p.department) LIKE ? ESCAPE '\\')",
      );
      args.push(pattern, pattern, pattern);
    }
    if (query.kind) {
      conditions.push('p.kind=?');
      args.push(query.kind);
    }
    if (deleted) conditions.push('p.deleted_at IS NOT NULL');
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const countWhere = deleted ? where : where ? where + ' AND p.deleted_at IS NULL' : ' WHERE p.deleted_at IS NULL';
    const [rows, count] = await Promise.all([
      this.all(
        `${peopleSummarySql(today, deleted)}${where} ORDER BY CASE WHEN p.document=? COLLATE NOCASE THEN 0 ELSE 1 END,p.name,p.id LIMIT ? OFFSET ?`,
        ...args,
        query.q,
        query.limit,
        (query.page - 1) * query.limit,
      ),
      this.one(`SELECT COUNT(*) total FROM people p${countWhere}`, ...args),
    ]);
    return { rows: rows as PersonSummary[], total: count!.total as number, page: query.page, pageSize: query.limit };
  }
  async personSummary(id: string): Promise<PersonSummary> {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings?.timezone || 'America/La_Paz').date;
    const person = await this.one(peopleSummarySql(today) + ' WHERE p.id=?', id);
    if (!person) throw new ApiError(404, 'Persona no encontrada.');
    return person as PersonSummary;
  }
  async personDetail(id: string): Promise<Person> {
    this.require('admin');
    const person = await this.one(
      'SELECT p.*, (SELECT COUNT(*) FROM credentials c WHERE c.person_id=p.id AND c.active=1) credential_count FROM people p WHERE p.id=?',
      id,
    );
    if (!person) throw new ApiError(404, 'Persona no encontrada.');
    const links = await this.all('SELECT zone_id FROM person_zones WHERE person_id=? ORDER BY zone_id', id);
    return { ...person, zone_ids: links.map((link) => link.zone_id) } as Person;
  }
  async preparePerson(body: unknown, id?: string) {
    this.require('admin');
    return this.preparePersonRecord(body, id);
  }
  async prepareCheckoutMember(body: unknown) {
    this.require('operator');
    const p = personSchema.parse(body);
    if (
      p.kind !== 'member' ||
      p.status !== 'active' ||
      p.expires ||
      p.schedule_id ||
      p.zone_ids.some((zone) => zone !== generalAccessId)
    )
      this.require('admin');
    return this.preparePersonRecord(p);
  }
  private async preparePersonRecord(body: unknown, id?: string) {
    const p = personSchema.parse(body);
    if (p.kind === 'member' && !/^[1-9]\d{8,14}$/.test(p.phone))
      throw new ApiError(400, 'El número de WhatsApp del socio es obligatorio, con código de país.');
    const personId = id || crypto.randomUUID();
    if (id) {
      const current = await this.one('SELECT deleted_at FROM people WHERE id=?', id);
      if (!current) throw new ApiError(404, 'Registro no encontrado.');
      if (current.deleted_at) throw new ApiError(409, 'Esta ficha está dada de baja. Restáurala antes de editarla.');
    } else {
      const clash = await this.one('SELECT id FROM people WHERE document=? AND deleted_at IS NOT NULL', p.document);
      if (clash)
        throw new ApiError(
          409,
          'Ya existe una ficha dada de baja con ese documento. Restáurala desde el filtro «Dados de baja».',
        );
    }
    for (const zone of p.zone_ids) await this.exists('zones', zone);
    if (p.schedule_id) await this.exists('schedules', p.schedule_id);
    const values = [
      p.name,
      p.document,
      p.email,
      p.phone,
      p.department,
      p.kind,
      p.status,
      p.expires,
      p.schedule_id,
      p.notes,
    ];
    const statements = [
      id
        ? this.stmt(
            'UPDATE people SET name=?,document=?,email=?,phone=?,department=?,kind=?,status=?,expires=?,schedule_id=?,notes=? WHERE id=?',
            ...values,
            id,
          )
        : this.stmt(
            'INSERT INTO people(name,document,email,phone,department,kind,status,expires,schedule_id,notes,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            ...values,
            personId,
            Date.now(),
          ),
      this.stmt('DELETE FROM person_zones WHERE person_id=?', personId),
      ...[...new Set([...p.zone_ids, generalAccessId])].map((zone) =>
        this.stmt('INSERT INTO person_zones(person_id,zone_id) VALUES(?,?)', personId, zone),
      ),
      this.audit(id ? 'person.updated' : 'person.created', personId),
    ];
    return { id: personId, person: p, statements };
  }
  async savePerson(body: unknown, id?: string) {
    const prepared = await this.preparePerson(body, id);
    await this.db.batch(prepared.statements);
    return { id: prepared.id };
  }
  /**
   * Baja lógica: la ficha sale del directorio y sus credenciales dejan de abrir, pero
   * eventos, asistencia, planes y cobros siguen intactos para los reportes.
   */
  async deletePerson(id: string) {
    this.require('admin');
    const person = await this.one('SELECT id,deleted_at FROM people WHERE id=?', id);
    if (!person) throw new ApiError(404, 'Registro no encontrado.');
    if (person.deleted_at) return { id, deleted_at: person.deleted_at as number };
    const inside = await this.one(
      `SELECT 1 one FROM (${presenceSql}) e WHERE e.person_id=? AND e.direction='entry'`,
      id,
    );
    if (inside)
      throw new ApiError(409, 'Esta persona tiene una entrada abierta. Registra su salida antes de darla de baja.');
    const now = Date.now();
    await this.db.batch([
      this.stmt('UPDATE people SET deleted_at=?,deleted_by=? WHERE id=?', now, this.actor.email, id),
      this.stmt(
        'UPDATE credentials SET active=0 WHERE person_id=? AND active=1 AND NOT EXISTS(SELECT 1 FROM visits WHERE credential_id=credentials.id)',
        id,
      ),
      this.audit('person.deleted', id),
    ]);
    return { id, deleted_at: now };
  }
  /** Reactiva una ficha dada de baja. Las credenciales revocadas se emiten de nuevo a mano. */
  async restorePerson(id: string) {
    this.require('admin');
    const person = await this.one('SELECT id,deleted_at FROM people WHERE id=?', id);
    if (!person) throw new ApiError(404, 'Registro no encontrado.');
    if (!person.deleted_at) return { id };
    await this.db.batch([
      this.stmt('UPDATE people SET deleted_at=NULL,deleted_by=NULL WHERE id=?', id),
      this.audit('person.restored', id),
    ]);
    return { id };
  }
  async saveZone(body: unknown, id?: string) {
    this.require('admin');
    const p = z
      .object({
        name: text,
        description: z.string().trim().max(300).default(''),
        capacity: z.number().int().min(0).max(100000),
        active: z.number().int().min(0).max(1),
      })
      .parse(body);
    const zoneId = id || crypto.randomUUID();
    if (id) await this.exists('zones', id);
    await this.db.batch([
      id
        ? this.stmt(
            'UPDATE zones SET name=?,description=?,capacity=?,active=? WHERE id=?',
            p.name,
            p.description,
            p.capacity,
            p.active,
            id,
          )
        : this.stmt(
            'INSERT INTO zones(id,name,description,capacity,active) VALUES(?,?,?,?,?)',
            zoneId,
            p.name,
            p.description,
            p.capacity,
            p.active,
          ),
      this.audit(id ? 'zone.updated' : 'zone.created', zoneId),
    ]);
    return { id: zoneId };
  }
  async saveSchedule(body: unknown, id?: string) {
    this.require('admin');
    const p = scheduleSchema.parse(body);
    const scheduleId = id || crypto.randomUUID();
    if (id) await this.exists('schedules', id);
    await this.db.batch([
      id
        ? this.stmt(
            'UPDATE schedules SET name=?,days=?,start=?,end=?,grace_in=?,grace_out=? WHERE id=?',
            p.name,
            JSON.stringify([...new Set(p.days)]),
            p.start,
            p.end,
            p.grace_in,
            p.grace_out,
            id,
          )
        : this.stmt(
            'INSERT INTO schedules(id,name,days,start,end,grace_in,grace_out) VALUES(?,?,?,?,?,?,?)',
            scheduleId,
            p.name,
            JSON.stringify([...new Set(p.days)]),
            p.start,
            p.end,
            p.grace_in,
            p.grace_out,
          ),
      this.audit(id ? 'schedule.updated' : 'schedule.created', scheduleId),
    ]);
    return { id: scheduleId };
  }
  async credentials(personId: string) {
    await this.exists('people', personId);
    return this.all(
      `SELECT id,person_id,kind,label,suffix,active,created_at,(kind='qr' AND active=1 AND code_cipher IS NOT NULL) downloadable,
      (?='admin' OR (?='operator' AND (EXISTS(SELECT 1 FROM people WHERE id=credentials.person_id AND kind='member') OR EXISTS(SELECT 1 FROM pos_sales WHERE credential_id=credentials.id)))) shareable
      FROM credentials WHERE person_id=? AND NOT EXISTS(SELECT 1 FROM visits WHERE credential_id=credentials.id) ORDER BY created_at DESC`,
      this.actor.role,
      this.actor.role,
      personId,
    );
  }
  /** Every credential with its holder, for the credentials screen. Codes are never returned. */
  async credentialList(params: URLSearchParams) {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const query = z
      .object({
        q: z.string().trim().max(120),
        state: z.enum(['', 'active', 'revoked']),
        page: z.coerce.number().int().min(1).max(100000),
      })
      .parse({ q: params.get('q') || '', state: params.get('state') || '', page: params.get('page') ?? 1 });
    const conditions: string[] = ['NOT EXISTS(SELECT 1 FROM visits WHERE credential_id=c.id)'],
      args: any[] = [];
    if (query.q) {
      const pattern = '%' + searchFold(query.q).replace(/[\\%_]/g, (character) => '\\' + character) + '%';
      conditions.push("(search_fold(p.name) LIKE ? ESCAPE '\\' OR search_fold(p.document) LIKE ? ESCAPE '\\')");
      args.push(pattern, pattern);
    }
    if (query.state) {
      conditions.push('c.active=?');
      args.push(query.state === 'active' ? 1 : 0);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const limit = 50;
    const [rows, count] = await Promise.all([
      this.all(
        `SELECT c.id,c.kind,c.label,c.suffix,c.active,c.created_at,
          p.id person_id,p.name person_name,p.phone,p.document,p.department,p.kind person_kind,p.status person_status,
          p.expires,p.membership_managed,p.sessions_remaining,p.photo_path,(c.kind='qr' AND c.active=1 AND c.code_cipher IS NOT NULL) downloadable
         FROM credentials c JOIN ${effectivePeopleSql(today)} p ON p.id=c.person_id${where}
         ORDER BY c.active DESC,c.created_at DESC LIMIT ? OFFSET ?`,
        ...args,
        limit,
        (query.page - 1) * limit,
      ),
      this.one(
        `SELECT COUNT(*) total FROM credentials c JOIN people p ON p.id=c.person_id AND p.deleted_at IS NULL${where}`,
        ...args,
      ),
    ]);
    return { rows, total: count!.total as number, page: query.page, pageSize: limit };
  }
  /** Se ejecuta dentro de la transacción del cobro: crea un QR solo si no existe uno activo. */
  async preparePersonalQr(personId: string, label = 'Credencial permanente') {
    const id = crypto.randomUUID(),
      code = randomToken('GYM'),
      now = Date.now();
    return {
      id,
      code,
      statements: [
        this.stmt(
          `INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher)
           SELECT ?,?,'qr',?,?,?,?,? WHERE NOT EXISTS(${personalQrIdSql})`,
          id,
          personId,
          label,
          await hash(code),
          code.slice(-6),
          now,
          this.codec?.seal(code, id) || null,
          personId,
        ),
        this.stmt(
          `INSERT INTO audit(actor,action,entity_id,occurred_at)
           SELECT ?,'credential.issued',?,? WHERE EXISTS(SELECT 1 FROM credentials WHERE id=?)`,
          this.actor.email,
          id,
          now,
          id,
        ),
      ],
    };
  }
  /** Conserva el QR existente; NFC y biometría cambian solo al vincular otro identificador. */
  async issueCredential(personId: string, body: unknown) {
    this.require('admin');
    const person = await this.one('SELECT deleted_at FROM people WHERE id=?', personId);
    if (!person) throw new ApiError(404, 'Registro no encontrado.');
    if (person.deleted_at)
      throw new ApiError(409, 'Esta ficha está dada de baja. Restáurala antes de emitir credenciales.');
    const p = z
      .object({
        kind: z.enum(['qr', 'nfc', 'biometric']),
        label: text,
        code: z.string().trim().min(4).max(200).optional(),
      })
      .parse(body);
    if (p.kind !== 'qr' && !p.code) throw new ApiError(400, 'Indica el identificador leído por el equipo.');
    if (p.kind === 'qr') {
      const prepared = await this.preparePersonalQr(personId, p.label);
      await this.db.batch(prepared.statements);
      const current = await this.one(`SELECT id,code_cipher FROM credentials WHERE id=(${personalQrIdSql})`, personId);
      if (!current) throw new ApiError(409, 'No hay un QR activo. Vuelve a intentarlo.');
      if (current.id === prepared.id) return { id: current.id, code: prepared.code, kind: 'qr' };
      if (!current.code_cipher || !this.codec)
        throw new ApiError(
          409,
          'Este socio conserva su QR anterior, pero no se puede recuperar su imagen. Puede seguir usando su tarjeta existente.',
        );
      return { id: current.id, code: this.codec.open(current.code_cipher, current.id), kind: 'qr' };
    }
    const code = p.code!;
    const id = crypto.randomUUID();
    const statements = [
      this.stmt(
        'UPDATE credentials SET active=0 WHERE person_id=? AND kind=? AND active=1 AND NOT EXISTS(SELECT 1 FROM visits WHERE credential_id=credentials.id)',
        personId,
        p.kind,
      ),
    ];
    statements.push(
      this.stmt(
        'INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher) VALUES(?,?,?,?,?,?,?,?)',
        id,
        personId,
        p.kind,
        p.label,
        await hash(code),
        code.slice(-6),
        Date.now(),
        null,
      ),
      this.audit('credential.issued', id),
    );
    await this.db.batch(statements);
    return { id, code, kind: p.kind };
  }
  async revokeCredential(id: string) {
    this.require('admin');
    await this.exists('credentials', id);
    await this.db.batch([
      this.stmt('UPDATE credentials SET active=0 WHERE id=?', id),
      this.audit('credential.revoked', id),
    ]);
    return { ok: true };
  }
  async credentialCard(id: string) {
    this.require('operator');
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const row = await this.one(
      `SELECT c.id,c.kind,c.active,c.code_cipher,c.label,p.id person_id,p.name,p.document,p.department,p.kind person_kind,p.expires,p.membership_managed,p.sessions_remaining,p.photo_path
      FROM credentials c JOIN ${effectivePeopleSql(today)} p ON p.id=c.person_id WHERE c.id=?`,
      id,
    );
    if (!row) throw new ApiError(404, 'Credencial no encontrada.');
    if (this.actor.role !== 'admin' && !(
      (row.person_kind === 'member' && !(await this.one('SELECT id FROM visits WHERE credential_id=?', id))) ||
      await this.one('SELECT id FROM pos_sales WHERE credential_id=?', id)
    )) throw new ApiError(403, 'Solo puedes compartir las credenciales de socios o de cobros de planes.');
    if (!row.active || row.kind !== 'qr') throw new ApiError(409, 'Solo puedes descargar una credencial QR activa.');
    if (!row.code_cipher || !this.codec)
      throw new ApiError(
        409,
        'Esta credencial antigua no permite recuperar la imagen. Conserva su tarjeta existente; solo anúlala si deseas reemplazarla expresamente.',
      );
    const code = this.codec.open(row.code_cipher, row.id);
    const { code_cipher, active, ...card } = row;
    return { ...card, code };
  }

  async expirations(params: URLSearchParams, at = new Date()) {
    this.require('admin');
    const settings = await this.one('SELECT name,timezone FROM settings WHERE id=1');
    const today = localParts(at, settings!.timezone).date,
      through = nextDate(today, 3);
    const view = z.enum(['soon', 'overdue', 'all']).parse(params.get('view') || 'soon');
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .parse(params.get('page') || 1);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(params.get('limit') || 50);
    const q = z
      .string()
      .max(120)
      .parse(params.get('q') || '')
      .trim();
    const base = "p.status='active' AND p.expires IS NOT NULL";
    const conditions = [base],
      args: unknown[] = [];
    if (view === 'soon') {
      conditions.push('p.expires>=? AND p.expires<=?');
      args.push(today, through);
    }
    if (view === 'overdue') {
      conditions.push('p.expires<?');
      args.push(today);
    }
    if (q) {
      const pattern = '%' + searchFold(q).replace(/[\\%_]/g, (character) => '\\' + character) + '%';
      conditions.push("(search_fold(p.name) LIKE ? ESCAPE '\\' OR search_fold(p.document) LIKE ? ESCAPE '\\')");
      args.push(pattern, pattern);
    }
    const where = conditions.join(' AND ');
    const join = `FROM ${effectivePeopleSql(today)} p LEFT JOIN renewal_contacts r ON r.person_id=p.id AND r.expires=p.expires`;
    const [rows, count, summary] = await Promise.all([
      this.all(
        `SELECT p.id,p.name,p.document,p.phone,p.expires,p.photo_path,r.notified_at ${join} WHERE ${where} ORDER BY r.notified_at IS NOT NULL,p.expires,p.name LIMIT ? OFFSET ?`,
        ...args,
        limit,
        (page - 1) * limit,
      ),
      this.one(`SELECT COUNT(*) total ${join} WHERE ${where}`, ...args),
      this.one(
        `SELECT COUNT(CASE WHEN p.expires BETWEEN ? AND ? THEN 1 END) soon,
        COUNT(CASE WHEN p.expires=? THEN 1 END) today,
        COUNT(CASE WHEN p.expires<? THEN 1 END) overdue,
        COUNT(CASE WHEN p.expires BETWEEN ? AND ? AND r.notified_at IS NULL THEN 1 END) pending,
        COUNT(CASE WHEN p.expires BETWEEN ? AND ? AND p.phone='' THEN 1 END) withoutPhone
        ${join} WHERE ${base}`,
        today,
        through,
        today,
        today,
        today,
        through,
        today,
        through,
      ),
    ]);
    return {
      rows: (
        rows as {
          id: string;
          name: string;
          document: string;
          phone: string;
          expires: string;
          photo_path: string | null;
          notified_at: number | null;
        }[]
      ).map((row) => ({
        ...row,
        days: remainingDays(row.expires, today),
        message: renewalMessage(row.name, settings!.name, row.expires, remainingDays(row.expires, today)),
      })),
      total: count!.total,
      summary: summary! as { soon: number; today: number; overdue: number; pending: number; withoutPhone: number },
      today,
      page,
      pageSize: limit,
    };
  }
  async markRenewal(id: string, body: unknown) {
    this.require('admin');
    const p = z.object({ expires: date, notified: z.boolean() }).parse(body);
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const person = await this.one(`SELECT expires FROM ${effectivePeopleSql(today)} WHERE id=?`, id);
    if (!person) throw new ApiError(404, 'Persona no encontrada.');
    if (person.expires !== p.expires)
      throw new ApiError(409, 'El vencimiento cambió. Actualiza la lista antes de marcar el aviso.');
    await this.db.batch([
      p.notified
        ? this.stmt(
            'INSERT INTO renewal_contacts(person_id,expires,notified_at,actor) VALUES(?,?,?,?) ON CONFLICT(person_id,expires) DO UPDATE SET notified_at=excluded.notified_at,actor=excluded.actor',
            id,
            p.expires,
            Date.now(),
            this.actor.email,
          )
        : this.stmt('DELETE FROM renewal_contacts WHERE person_id=? AND expires=?', id, p.expires),
      this.audit(p.notified ? 'renewal.notified' : 'renewal.pending', id),
    ]);
    return { ok: true };
  }
  async devices() {
    this.require('admin');
    return this.all(
      'SELECT d.id,d.name,d.zone_id,z.name zone_name,d.kind,d.direction,d.active,d.last_seen FROM devices d JOIN zones z ON z.id=d.zone_id ORDER BY d.name',
    );
  }
  async createDevice(body: unknown) {
    this.require('admin');
    const p = z
      .object({
        name: text,
        zone_id: text.default(generalAccessId),
        kind: z.enum(['qr', 'nfc', 'biometric']),
        direction: z.enum(['entry', 'exit', 'auto']),
      })
      .parse(body);
    await this.exists('zones', p.zone_id);
    const id = crypto.randomUUID(),
      token = randomToken('device');
    await this.db.batch([
      this.stmt(
        'INSERT INTO devices(id,name,zone_id,kind,direction,hash,created_at) VALUES(?,?,?,?,?,?,?)',
        id,
        p.name,
        p.zone_id,
        p.kind,
        p.direction,
        await hash(token),
        Date.now(),
      ),
      this.audit('device.created', id),
    ]);
    return { id, token };
  }
  async revokeDevice(id: string) {
    this.require('admin');
    await this.exists('devices', id);
    await this.db.batch([this.stmt('UPDATE devices SET active=0 WHERE id=?', id), this.audit('device.revoked', id)]);
    return { ok: true };
  }
  async access(body: unknown, device?: Row, at = new Date()) {
    if (!device) this.require('operator');
    const p = z
      .object({
        code: z.string().trim().max(200).optional(),
        person_id: text.optional(),
        reason: z.string().trim().max(300).optional(),
        zone_id: text.optional(),
        direction: z.enum(['entry', 'exit', 'auto']).optional(),
        request_id: z.string().uuid(),
        expected_actor_id: text.optional(),
        expected_installation_id: text.optional(),
      })
      .parse(body);
    if (p.expected_actor_id && p.expected_actor_id !== this.actor.id)
      throw new ApiError(403, 'Este movimiento pertenece a otra cuenta. Inicia sesión con la cuenta que lo registró.');
    if (p.expected_installation_id) {
      const installation = await this.one('SELECT owner FROM settings WHERE id=1');
      if (p.expected_installation_id !== (await hash(installation!.owner)))
        throw new ApiError(409, 'Este movimiento pertenece a otra instalación de GymPASS.');
    }
    if (device && p.person_id) throw new ApiError(400, 'Los lectores requieren una credencial.');
    const manual = !!p.person_id;
    if (manual && (!p.reason || p.reason.length < 5))
      throw new ApiError(400, 'Escribe el motivo del registro manual (al menos 5 caracteres).');
    if (!manual && !p.code) throw new ApiError(400, 'Presenta una credencial.');
    const zoneId = device?.zone_id || p.zone_id || generalAccessId;
    const direction = device?.direction || p.direction;
    if (!direction) throw new ApiError(400, 'Selecciona el movimiento.');
    await this.exists('zones', zoneId);
    if (manual) {
      const target = await this.one('SELECT deleted_at FROM people WHERE id=?', p.person_id!);
      if (!target) throw new ApiError(404, 'Registro no encontrado.');
      if (target.deleted_at) throw new ApiError(409, 'Esta ficha está dada de baja y no puede registrar accesos.');
    }
    const settings = await this.one('SELECT timezone,auto_close_hours,closing_time FROM settings WHERE id=1');
    if (settings?.closing_time || settings?.auto_close_hours) {
      const system = new Service(
        this.db,
        { id: 'system', email: 'system', name: 'Sistema', role: 'admin' },
        this.codec,
      );
      await system.closeStaleSessions(at);
    }
    const local = localParts(at, settings!.timezone);
    const codeHash = await hash(p.code || '');
    const payloadHash = await hash(JSON.stringify([codeHash, p.person_id || null, zoneId, direction, p.reason || '']));
    const requestKey = (device ? 'device:' + device.id : this.actor.id) + ':' + p.request_id;
    // One INSERT...SELECT evaluates the current permissions and occupancy at the write itself.
    // Concurrent scans therefore cannot bypass capacity or the entry/exit state.
    // 'auto' resolves to the opposite of the last movement inside the same statement, so two
    // simultaneous scans of the same credential cannot both resolve to the same direction.
    const sql = `WITH candidate AS (
      SELECT p.*,c.id credential_id,c.active credential_active,c.kind credential_kind,z.active zone_active,z.capacity,z.name zone_name,
        v.id invitation_id,v.expected_date invitation_date,v.used_at invitation_used,v.status invitation_status,v.access_mode invitation_access,NULLIF(v.guest_name,'') invitation_name,
        s.days,s.start,s.end,
        (SELECT direction FROM events WHERE person_id=p.id AND zone_id=z.id AND allowed=1 ORDER BY occurred_at DESC,id DESC LIMIT 1) last_direction,
        (SELECT COUNT(*) FROM (${presenceSql}) occupancy WHERE occupancy.zone_id=z.id) inside,
        EXISTS(SELECT 1 FROM person_zones pz WHERE pz.person_id=p.id AND pz.zone_id=z.id) has_zone,
        ((p.legacy_access=0 OR EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id)) AND NOT ${legacyCoverageSql(local.date)}) pos_managed,
        EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.start_date<=?
          AND ((m.unit<>'sessions' AND m.end_date>?) OR (m.unit='sessions' AND m.sessions_remaining>0))) pos_valid,
        EXISTS(SELECT 1 FROM pos_memberships m WHERE m.person_id=p.id AND m.status='active' AND m.unit='sessions' AND m.start_date<=?) pos_sessions
      FROM zones z LEFT JOIN credentials c ON c.hash=?
      LEFT JOIN visits v ON v.credential_id=c.id AND ?=0
      LEFT JOIN people p ON (p.id=CASE WHEN ?=1 THEN ? ELSE c.person_id END) AND p.deleted_at IS NULL
      LEFT JOIN schedules s ON s.id=p.schedule_id WHERE z.id=?
    ), resolved AS (
      SELECT *,CASE WHEN ?='auto' THEN (CASE WHEN last_direction='entry' THEN 'exit' ELSE 'entry' END) ELSE ? END direction
      FROM candidate
    ), decision AS (
      SELECT *,CASE
        WHEN id IS NULL THEN 'UNKNOWN'
        WHEN ?=0 AND credential_active<>1 THEN 'REVOKED'
        WHEN ?<>'' AND credential_kind<>? THEN 'METHOD'
        WHEN invitation_id IS NOT NULL AND invitation_status IN('cancelled','checked_out') THEN 'INVITATION_CLOSED'
        WHEN invitation_id IS NOT NULL AND invitation_used IS NOT NULL AND invitation_access='single' THEN 'INVITATION_USED'
        WHEN invitation_id IS NOT NULL AND invitation_date<>? THEN 'INVITATION_DATE'
        WHEN direction='exit' AND COALESCE(last_direction,'exit')<>'entry' THEN 'NOT_INSIDE'
        WHEN direction='exit' THEN 'OK'
        WHEN zone_active<>1 THEN 'ZONE_DISABLED'
        WHEN EXISTS(SELECT 1 FROM blocklist b WHERE b.document=resolved.document) THEN 'BLOCKLIST'
        WHEN status<>'active' THEN 'BLOCKED'
        WHEN kind='member' AND pos_managed=1 AND pos_valid=0 THEN CASE WHEN pos_sessions=1 THEN 'SESSIONS_EXHAUSTED' ELSE 'MEMBERSHIP_REQUIRED' END
        WHEN (kind<>'member' OR pos_managed=0) AND expires IS NOT NULL AND expires<? THEN 'EXPIRED'
        WHEN ?<>'general' AND has_zone=0 THEN 'ZONE_DENIED'
        WHEN ?<>'general' AND schedule_id IS NOT NULL AND NOT (
          (start=end AND EXISTS(SELECT 1 FROM json_each(days) WHERE value=?)) OR
          (start<end AND ? >= start AND ? < end AND EXISTS(SELECT 1 FROM json_each(days) WHERE value=?)) OR
          (start>end AND ((? >= start AND EXISTS(SELECT 1 FROM json_each(days) WHERE value=?)) OR (? < end AND EXISTS(SELECT 1 FROM json_each(days) WHERE value=?))))
        ) THEN 'OUT_OF_SCHEDULE'
        WHEN last_direction='entry' THEN 'ALREADY_INSIDE'
        WHEN capacity>0 AND inside>=capacity THEN 'CAPACITY'
        ELSE 'OK' END decision FROM resolved resolved
    ) INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,direction,method,allowed,reason,detail,actor,device_id,occurred_at,local_date,credential_id)
      SELECT ?,?,id,COALESCE(invitation_name,name,'Credencial desconocida'),?,zone_name,direction,CASE WHEN ?=1 THEN 'manual' ELSE COALESCE(credential_kind,'qr') END,decision='OK',decision,?,?,?,?,?,CASE WHEN ?=0 THEN credential_id END FROM decision WHERE 1
      ON CONFLICT(request_key) DO NOTHING`;
    const method = device?.kind || '';
    const insert = this.stmt(
      sql,
      local.date,
      local.date,
      local.date,
      codeHash,
      manual ? 1 : 0,
      manual ? 1 : 0,
      p.person_id || null,
      zoneId,
      direction,
      direction,
      manual ? 1 : 0,
      method,
      method,
      local.date,
      local.date,
      zoneId,
      zoneId,
      local.day,
      local.time,
      local.time,
      local.day,
      local.time,
      local.day,
      local.time,
      (local.day + 6) % 7,
      requestKey,
      payloadHash,
      zoneId,
      manual ? 1 : 0,
      p.reason || '',
      device ? 'Lector: ' + device.name : this.actor.email,
      device?.id || null,
      at.getTime(),
      local.date,
      manual ? 1 : 0,
    );
    if (device)
      await this.db.batch([insert, this.stmt('UPDATE devices SET last_seen=? WHERE id=?', Date.now(), device.id)]);
    else await insert.run();
    const event = await this.one('SELECT * FROM events WHERE request_key=?', requestKey);
    if (!event) throw new ApiError(500, 'No se pudo registrar el acceso.');
    if (event.payload_hash !== payloadHash)
      throw new ApiError(409, 'El identificador de solicitud ya se utilizó con otros datos.');
    if (event.person_id) {
      const rights = await this.one(
        `SELECT membership_managed,sessions_remaining,expires,valid_until FROM ${effectivePeopleSql(local.date)} WHERE id=?`,
        event.person_id,
      );
      if (rights?.membership_managed)
        return {
          ...event,
          ...rights,
          membership: { managed: true, valid_until: rights.valid_until, sessions_remaining: rights.sessions_remaining },
        };
    }
    return event;
  }
  async eventList(params: URLSearchParams, exportAll = false) {
    if (exportAll) this.requireReports();
    const conditions: string[] = [],
      args: any[] = [];
    for (const [key, sql] of [
      ['from', 'local_date>=?'],
      ['to', 'local_date<=?'],
      ['zone', 'zone_id=?'],
      ['person', 'person_id=?'],
    ] as const) {
      const value = params.get(key);
      if (value) {
        if (key === 'from' || key === 'to') date.parse(value);
        conditions.push(sql);
        args.push(value);
      }
    }
    const result = params.get('result');
    if (result === 'allowed' || result === 'denied') {
      conditions.push('allowed=?');
      args.push(result === 'allowed' ? 1 : 0);
    }
    const q = params.get('q')?.slice(0, 120);
    if (q) {
      // El documento se compara completo: un carnet parcial no debe mezclar a otros socios.
      conditions.push(
        '(person_name LIKE ? OR zone_name LIKE ? OR person_id IN (SELECT id FROM people WHERE document=? COLLATE NOCASE))',
      );
      args.push('%' + q + '%', '%' + q + '%', q.trim());
    }
    if (params.get('from') && params.get('to') && params.get('from')! > params.get('to')!)
      throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const page = Math.max(1, Math.min(100000, Math.floor(Number(params.get('page')) || 1)));
    const limit = exportAll ? 10001 : 50;
    const [rows, count] = await Promise.all([
      this.all(
        `SELECT * FROM events ${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`,
        ...args,
        limit,
        exportAll ? 0 : (page - 1) * limit,
      ),
      this.one(`SELECT COUNT(*) total FROM events ${where}`, ...args),
    ]);
    if (exportAll && rows.length > 10000)
      throw new ApiError(400, 'Reduce el rango: la exportación admite hasta 10.000 registros.');
    return { rows, total: count!.total, page };
  }
  async gymSessions(params: URLSearchParams) {
    const person = z
      .string()
      .max(120)
      .parse(params.get('person') || '');
    const query = z
      .string()
      .trim()
      .max(120)
      .parse(params.get('q') || '');
    const state = z.enum(['all', 'open', 'closed']).parse(params.get('state') || 'all');
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const from = date.parse(params.get('from') || today),
      to = date.parse(params.get('to') || today);
    if (from > to || Date.parse(to) - Date.parse(from) > 93 * 86400000)
      throw new ApiError(400, 'Selecciona un período de hasta 93 días.');
    const rows = await this.all(
      `WITH relevant AS (
        SELECT person_id,zone_id,MIN(occurred_at) first_time FROM events
        WHERE allowed=1 AND direction='entry' AND local_date BETWEEN ? AND ? GROUP BY person_id,zone_id
      ), sequenced AS (
        SELECT e.id,e.person_id,e.person_name,e.zone_name,e.local_date,e.direction,e.occurred_at,
          LEAD(e.direction) OVER movements next_direction,
          LEAD(e.occurred_at) OVER movements next_time,
          LEAD(e.reason) OVER movements next_reason
        FROM events e JOIN relevant r ON e.person_id=r.person_id AND e.zone_id=r.zone_id AND e.occurred_at>=r.first_time
        WHERE e.allowed=1 WINDOW movements AS (PARTITION BY e.person_id,e.zone_id ORDER BY e.occurred_at,e.id)
      ) SELECT id,person_id,person_name,zone_name,local_date,occurred_at entry_at,
        COALESCE((SELECT document FROM people p WHERE p.id=sequenced.person_id),'') document,
        CASE WHEN next_direction='exit' THEN next_time END exit_at,
        CASE WHEN next_direction='exit' AND next_reason='AUTO_CLOSE' THEN 1 ELSE 0 END auto_closed
      FROM sequenced WHERE direction='entry' AND local_date BETWEEN ? AND ?
        AND (?='' OR person_id=?)
        AND (?='' OR instr(search_fold(person_name),?)>0 OR EXISTS (
          SELECT 1 FROM people p WHERE p.id=sequenced.person_id AND search_fold(p.document)=?))
        AND (?='all' OR (?='open' AND (next_direction IS NULL OR next_direction!='exit'))
          OR (?='closed' AND next_direction='exit'))
      ORDER BY occurred_at DESC,id DESC LIMIT 10001`,
      from,
      to,
      from,
      to,
      person,
      person,
      query,
      searchFold(query),
      searchFold(query),
      state,
      state,
      state,
    );
    if (rows.length > 10000) throw new ApiError(400, 'Reduce el período del reporte.');
    return { rows: rows as GymSession[], from, to };
  }
  async attendance(params: URLSearchParams) {
    this.requireReports();
    const { rows, from, to } = await this.gymSessions(params);
    // Each shift belongs to the date of its entry. Open sessions remain explicitly incomplete.
    const groups = new Map<string, AttendanceRow>();
    for (const r of rows) {
      const key = r.person_id + ':' + r.local_date;
      const g: AttendanceRow = groups.get(key) || {
        person_id: r.person_id,
        name: r.person_name,
        date: r.local_date,
        first: r.entry_at,
        last: null,
        minutes: 0,
        sessions: 0,
        open: 0,
        auto_closed: 0,
        zones: [],
      };
      g.first = Math.min(g.first, r.entry_at);
      if (r.exit_at !== null) {
        g.last = Math.max(g.last || 0, r.exit_at);
        g.minutes += (r.exit_at - r.entry_at) / 60000;
      } else g.open++;
      g.auto_closed += r.auto_closed;
      g.sessions++;
      if (!g.zones.includes(r.zone_name)) g.zones.push(r.zone_name);
      groups.set(key, g);
    }
    return { rows: [...groups.values()].map((r) => ({ ...r, minutes: Math.floor(r.minutes) })), from, to };
  }
  /** Raw entry/exit pairs for a set of people, used by every attendance view. */
  private async attendanceSessions(from: string, to: string, personIds: string[]) {
    if (!personIds.length) return [];
    const list = personIds.map(() => '?').join(',');
    return this.all(
      `WITH relevant AS (
        SELECT person_id,zone_id,MIN(occurred_at) first_time FROM events
        WHERE allowed=1 AND direction='entry' AND local_date BETWEEN ? AND ? AND person_id IN (${list})
        GROUP BY person_id,zone_id
      ), sequenced AS (
        SELECT e.person_id,e.zone_name,e.local_date,e.direction,e.occurred_at,
          LEAD(e.direction) OVER movements next_direction,
          LEAD(e.occurred_at) OVER movements next_time,
          LEAD(e.reason) OVER movements next_reason
        FROM events e JOIN relevant r ON e.person_id=r.person_id AND e.zone_id=r.zone_id AND e.occurred_at>=r.first_time
        WHERE e.allowed=1 WINDOW movements AS (PARTITION BY e.person_id,e.zone_id ORDER BY e.occurred_at,e.id)
      ) SELECT person_id,zone_name,local_date,occurred_at entry_at,
        CASE WHEN next_direction='exit' THEN next_time END exit_at,
        CASE WHEN next_direction='exit' AND next_reason='AUTO_CLOSE' THEN 1 ELSE 0 END auto_closed
      FROM sequenced WHERE direction='entry' AND local_date BETWEEN ? AND ? ORDER BY occurred_at LIMIT 20001`,
      from,
      to,
      ...personIds,
      from,
      to,
    );
  }

  /**
   * Day-by-day attendance measured against each person's assigned shift: lateness, early
   * departures, overtime and absences. Days covered by a calendar exception never count as
   * absent, and a person without a shift is reported as worked time only.
   */
  async attendanceReport(params: URLSearchParams): Promise<AttendanceReport> {
    this.requireReports();
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const timezone = settings!.timezone as string;
    const today = localParts(new Date(), timezone).date;
    const from = date.parse(params.get('from') || today),
      to = date.parse(params.get('to') || today);
    if (from > to) throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    if (Date.parse(to) - Date.parse(from) > 93 * 86400000)
      throw new ApiError(400, 'Selecciona un período de hasta 93 días.');

    const conditions: string[] = [],
      args: string[] = [];
    const personFilter = params.get('person');
    if (personFilter) {
      conditions.push('p.id=?');
      args.push(personFilter);
    }
    const department = params.get('department');
    if (department) {
      conditions.push('p.department=?');
      args.push(department);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const people = await this.all(
      `SELECT p.id,p.name,p.document,p.department,p.schedule_id,
        s.name schedule_name,s.days,s.start,s.end,s.grace_in,s.grace_out
       FROM people p LEFT JOIN schedules s ON s.id=p.schedule_id${where} ORDER BY p.name,p.id LIMIT 501`,
      ...args,
    );
    if (people.length > 500)
      throw new ApiError(400, 'El reporte admite hasta 500 personas. Filtra por área o por persona.');

    const dates = eachDate(from, to);
    const sessions = await this.attendanceSessions(
      from,
      to,
      people.map((person) => person.id),
    );
    if (sessions.length > 20000) throw new ApiError(400, 'Reduce el período del reporte.');
    const exceptions = await this.all(
      'SELECT date,kind,label,person_id FROM calendar_exceptions WHERE date BETWEEN ? AND ?',
      from,
      to,
    );
    const closedMonths = (
      await this.all(
        'SELECT month FROM attendance_periods WHERE month BETWEEN ? AND ?',
        from.slice(0, 7),
        to.slice(0, 7),
      )
    ).map((row) => row.month as string);

    // Sessions are keyed by the local date of their entry, as in the sessions view.
    const byDay = new Map<string, Row[]>();
    for (const session of sessions) {
      const key = session.person_id + ':' + session.local_date;
      const list = byDay.get(key);
      if (list) list.push(session);
      else byDay.set(key, [session]);
    }
    const exceptionFor = (personId: string, day: string) =>
      exceptions.find((item) => item.date === day && item.person_id === personId) ||
      exceptions.find((item) => item.date === day && item.person_id === null);

    const totals = emptyTotals();
    const rows: AttendancePerson[] = people.map((person) => {
      const personTotals = emptyTotals();
      const days: Record<string, AttendanceDay> = {};
      const scheduleDays: number[] = person.days ? JSON.parse(person.days) : [];
      for (const day of dates) {
        const exception = exceptionFor(person.id, day);
        const weekday = new Date(Date.parse(day + 'T12:00:00Z')).getUTCDay();
        const scheduled = !!person.schedule_id && scheduleDays.includes(weekday);
        const list = byDay.get(person.id + ':' + day) || [];

        let expectedStartAt = 0,
          expectedEndAt = 0,
          expectedMinutes = 0;
        if (scheduled) {
          expectedStartAt = zonedTime(day, person.start, timezone);
          expectedEndAt =
            person.start === person.end
              ? expectedStartAt + 86400000
              : person.end > person.start
                ? zonedTime(day, person.end, timezone)
                : zonedTime(nextDate(day), person.end, timezone);
          expectedMinutes = Math.round((expectedEndAt - expectedStartAt) / 60000);
        }

        let first: number | null = null,
          last: number | null = null,
          minutes = 0,
          open = 0,
          autoClosed = 0;
        const zones: string[] = [];
        for (const session of list) {
          first = first === null ? session.entry_at : Math.min(first, session.entry_at);
          if (session.exit_at !== null) {
            last = Math.max(last ?? 0, session.exit_at);
            minutes += (session.exit_at - session.entry_at) / 60000;
          } else open++;
          autoClosed += session.auto_closed;
          if (!zones.includes(session.zone_name)) zones.push(session.zone_name);
        }
        minutes = Math.floor(minutes);

        const lateMinutes =
          scheduled && first !== null
            ? Math.max(0, Math.round((first - (expectedStartAt + person.grace_in * 60000)) / 60000))
            : 0;
        const earlyMinutes =
          scheduled && last !== null && !open
            ? Math.max(0, Math.round((expectedEndAt - person.grace_out * 60000 - last) / 60000))
            : 0;
        const overtimeMinutes =
          scheduled && last !== null ? Math.max(0, Math.round((last - expectedEndAt) / 60000)) : 0;

        let status: DayStatus;
        if (exception) status = exception.kind as DayStatus;
        else if (!person.schedule_id) status = list.length ? (open ? 'open' : 'present') : 'untracked';
        else if (!scheduled) status = list.length ? (open ? 'open' : 'present') : 'rest';
        else if (!list.length) status = 'absent';
        else if (open) status = 'open';
        else status = lateMinutes > 0 ? 'late' : 'present';

        const entry: AttendanceDay = {
          person_id: person.id,
          name: person.name,
          document: person.document,
          department: person.department,
          date: day,
          status,
          schedule_name: person.schedule_name ?? null,
          expected_start: scheduled ? person.start : null,
          expected_end: scheduled ? person.end : null,
          expected_minutes: expectedMinutes,
          first,
          last,
          minutes,
          late_minutes: lateMinutes,
          early_minutes: earlyMinutes,
          overtime_minutes: overtimeMinutes,
          sessions: list.length,
          open,
          auto_closed: autoClosed,
          zones,
          note: exception ? exception.label : '',
        };
        days[day] = entry;

        const counts = !exception && scheduled;
        if (counts) {
          personTotals.expected_days++;
          personTotals.expected_minutes += expectedMinutes;
        }
        if (list.length) personTotals.worked_days++;
        if (status === 'absent') personTotals.absences++;
        if (status === 'late') personTotals.late_days++;
        personTotals.minutes += minutes;
        personTotals.late_minutes += lateMinutes;
        personTotals.early_minutes += earlyMinutes;
        personTotals.overtime_minutes += overtimeMinutes;
        personTotals.open += open;
      }
      for (const key of Object.keys(personTotals) as (keyof AttendanceTotals)[]) totals[key] += personTotals[key];
      return {
        person_id: person.id,
        name: person.name,
        document: person.document,
        department: person.department,
        totals: personTotals,
        days,
      };
    });

    return {
      from,
      to,
      dates,
      people: rows,
      totals,
      closed: dates.every((day) => closedMonths.includes(day.slice(0, 7))),
      closedMonths,
    };
  }

  async calendarExceptions(params: URLSearchParams) {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const from = date.parse(params.get('from') || today.slice(0, 4) + '-01-01'),
      to = date.parse(params.get('to') || today.slice(0, 4) + '-12-31');
    if (from > to) throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    return this.all(
      `SELECT c.id,c.date,c.kind,c.label,c.person_id,p.name person_name FROM calendar_exceptions c
       LEFT JOIN people p ON p.id=c.person_id WHERE c.date BETWEEN ? AND ? ORDER BY c.date DESC,p.name LIMIT 2000`,
      from,
      to,
    );
  }
  private async assertOpenMonth(day: string) {
    if (await this.one('SELECT month FROM attendance_periods WHERE month=?', day.slice(0, 7)))
      throw new ApiError(409, `El período ${day.slice(0, 7)} está cerrado. Reábrelo para modificarlo.`);
  }
  async saveException(body: unknown) {
    this.require('admin');
    const p = exceptionSchema.parse(body);
    await this.assertOpenMonth(p.date);
    if (p.person_id) await this.exists('people', p.person_id);
    const id = crypto.randomUUID();
    await this.db.batch([
      this.stmt(
        `INSERT INTO calendar_exceptions(id,date,kind,label,person_id,created_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(date,COALESCE(person_id,'')) DO UPDATE SET kind=excluded.kind,label=excluded.label`,
        id,
        p.date,
        p.kind,
        p.label,
        p.person_id,
        Date.now(),
      ),
      this.audit('calendar.saved', p.date + (p.person_id ? ':' + p.person_id : '')),
    ]);
    return { id };
  }
  async deleteException(id: string) {
    this.require('admin');
    const existing = await this.one('SELECT date FROM calendar_exceptions WHERE id=?', id);
    if (!existing) throw new ApiError(404, 'Registro no encontrado.');
    await this.assertOpenMonth(existing.date);
    await this.db.batch([
      this.stmt('DELETE FROM calendar_exceptions WHERE id=?', id),
      this.audit('calendar.deleted', existing.date),
    ]);
    return { ok: true };
  }
  async attendancePeriods() {
    return this.all('SELECT month,closed_at,closed_by FROM attendance_periods ORDER BY month DESC LIMIT 60');
  }
  async setPeriod(body: unknown) {
    this.require('admin');
    const p = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), closed: z.boolean() }).parse(body);
    await this.db.batch([
      p.closed
        ? this.stmt(
            'INSERT INTO attendance_periods(month,closed_at,closed_by) VALUES(?,?,?) ON CONFLICT(month) DO NOTHING',
            p.month,
            Date.now(),
            this.actor.email,
          )
        : this.stmt('DELETE FROM attendance_periods WHERE month=?', p.month),
      this.audit(p.closed ? 'period.closed' : 'period.reopened', p.month),
    ]);
    return { ok: true };
  }

  // ---- Visits -------------------------------------------------------------

  async visits(params: URLSearchParams) {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const today = localParts(new Date(), settings!.timezone).date;
    const from = date.parse(params.get('from') || today),
      to = date.parse(params.get('to') || from);
    if (from > to) throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    const status = params.get('status');
    const conditions = ['v.expected_date BETWEEN ? AND ?'],
      args: any[] = [from, to];
    if (params.get('scope') === 'individual') conditions.push('v.batch_id IS NULL');
    if (status && ['expected', 'checked_in', 'checked_out', 'cancelled'].includes(status)) {
      conditions.push('v.status=?');
      args.push(status);
    }
    return this.all(
      `SELECT v.*,COALESCE(NULLIF(v.guest_name,''),p.name) person_name,p.document,p.photo_path,z.name zone_name,
        EXISTS(SELECT 1 FROM blocklist b WHERE b.document=p.document) blocked
       FROM visits v JOIN people p ON p.id=v.person_id JOIN zones z ON z.id=v.zone_id
       WHERE ${conditions.join(' AND ')} ORDER BY v.expected_date DESC,v.expected_from,p.name LIMIT 500`,
      ...args,
    );
  }
  /** Pre-registers a visit, creating the visitor record when the document is new. */
  async saveVisit(body: unknown) {
    this.require('operator');
    const p = z
      .object({
        person_id: text.optional(),
        name: text.optional(),
        document: text.optional(),
        email: email.default(''),
        company: z.string().trim().max(100).default(''),
        host_name: text,
        host_email: z.string().trim().email().max(200),
        purpose: z.string().trim().max(300).default(''),
        expected_date: date,
        expected_from: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .default('00:00'),
        expected_to: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .default('23:59'),
        zone_id: text.default(generalAccessId),
        access_mode: z.enum(['single', 'reentry']).default('single'),
      })
      .parse(body);
    await this.exists('zones', p.zone_id);
    if (p.expected_to <= p.expected_from) throw new ApiError(400, 'La hora final debe ser posterior a la inicial.');

    let personId = p.person_id;
    if (!personId) {
      if (!p.name || !p.document) throw new ApiError(400, 'Indica el nombre y el documento de la visita.');
      const existing = await this.one('SELECT id FROM people WHERE document=?', p.document);
      if (existing) personId = existing.id as string;
      else {
        const created = await this.savePersonAsVisitor(p.name, p.document, p.email, p.company, p.zone_id);
        personId = created.id;
      }
    } else await this.exists('people', personId);

    const blocked = await this.one(
      'SELECT b.reason FROM blocklist b JOIN people p ON p.document=b.document WHERE p.id=?',
      personId,
    );
    if (blocked) throw new ApiError(409, `Documento en lista de bloqueo: ${blocked.reason}`);

    const id = crypto.randomUUID();
    await this.db.batch([
      this.stmt(
        `INSERT INTO visits(id,person_id,host_email,host_name,purpose,expected_date,expected_from,expected_to,zone_id,created_at,created_by,access_mode)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        personId,
        p.host_email.toLowerCase(),
        p.host_name,
        p.purpose,
        p.expected_date,
        p.expected_from,
        p.expected_to,
        p.zone_id,
        Date.now(),
        this.actor.email,
        p.access_mode,
      ),
      this.audit('visit.created', id),
    ]);
    return { id, person_id: personId };
  }
  /** A visitor is an ordinary person with kind 'visitor', so every permission rule still applies. */
  private async savePersonAsVisitor(
    name: string,
    document: string,
    emailValue: string,
    company: string,
    zoneId: string,
  ) {
    const personId = crypto.randomUUID();
    await this.db.batch([
      this.stmt(
        `INSERT INTO people(id,name,document,email,department,kind,status,notes,created_at)
         VALUES(?,?,?,?,?,'visitor','active','',?)`,
        personId,
        name,
        document,
        emailValue,
        company,
        Date.now(),
      ),
      this.stmt('INSERT INTO person_zones(person_id,zone_id) VALUES(?,?)', personId, zoneId),
      this.audit('person.created', personId),
    ]);
    return { id: personId };
  }
  /**
   * Check-in records the consent, issues a one-visit QR and leaves the movement itself to the
   * normal access flow, so capacity, zone and schedule rules are never bypassed.
   */
  async checkInVisit(id: string, body: unknown) {
    this.require('operator');
    const p = z.object({ consent: z.literal(true) }).parse(body);
    void p;
    const visit = await this.one('SELECT * FROM visits WHERE id=?', id);
    if (!visit) throw new ApiError(404, 'Visita no encontrada.');
    if (visit.status !== 'expected' || visit.credential_id)
      throw new ApiError(409, 'Esta invitación ya tiene un QR o está cerrada.');
    const blocked = await this.one(
      'SELECT b.reason FROM blocklist b JOIN people p ON p.document=b.document WHERE p.id=?',
      visit.person_id,
    );
    if (blocked) throw new ApiError(409, `Documento en lista de bloqueo: ${blocked.reason}`);

    const code = randomToken('UMB'),
      credentialId = crypto.randomUUID(),
      now = Date.now();
    // Creating and linking the QR in one transaction prevents concurrent issuance from leaving
    // an unlinked, unrestricted credential. Invitations never replace a person's ordinary QR.
    await this.db.batch([
      this.stmt(
        `INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher)
         SELECT ?,?,'qr','Invitación de un día · un solo uso',?,?,?,?
         WHERE EXISTS(SELECT 1 FROM visits WHERE id=? AND status='expected' AND credential_id IS NULL)`,
        credentialId,
        visit.person_id,
        await hash(code),
        code.slice(-6),
        now,
        this.codec ? this.codec.seal(code, credentialId) : null,
        id,
      ),
      this.stmt(
        `UPDATE visits SET consent_at=?,credential_id=? WHERE id=? AND status='expected' AND credential_id IS NULL
         AND EXISTS(SELECT 1 FROM credentials WHERE id=?)`,
        now,
        credentialId,
        id,
        credentialId,
      ),
      this.stmt(
        `INSERT INTO audit(actor,action,entity_id,occurred_at)
        SELECT ?,'invitation.issued',?,? WHERE EXISTS(SELECT 1 FROM visits WHERE id=? AND credential_id=?)`,
        this.actor.email,
        id,
        now,
        id,
        credentialId,
      ),
    ]);
    const linked = await this.one('SELECT credential_id FROM visits WHERE id=?', id);
    if (linked?.credential_id !== credentialId)
      throw new ApiError(409, 'Esta invitación ya tiene un QR o está cerrada.');
    return { id: credentialId, code, kind: 'qr', visit_id: id, expected_date: visit.expected_date };
  }
  async visitPass(id: string) {
    this.require('operator');
    const row = await this.one(
      `SELECT c.id,c.active,c.code_cipher,v.status,v.used_at,v.access_mode
      FROM visits v JOIN credentials c ON c.id=v.credential_id WHERE v.id=?`,
      id,
    );
    if (!row) throw new ApiError(404, 'Primero emite el QR de la invitación.');
    if (
      !row.active ||
      ['cancelled', 'checked_out'].includes(row.status) ||
      (row.access_mode === 'single' && row.used_at !== null)
    )
      throw new ApiError(409, 'Esta invitación ya no está disponible.');
    if (!row.code_cipher || !this.codec)
      throw new ApiError(409, 'Este QR antiguo no se puede recuperar. Crea una nueva invitación.');
    return { code: this.codec.open(row.code_cipher, row.id) };
  }
  async personalizeInvitation(id: string, body: unknown) {
    this.require('operator');
    const p = z
      .object({
        guest_name: z.string().trim().max(100),
        invitation_note: z.string().trim().max(140),
        access_mode: z.enum(['single', 'reentry']),
      })
      .parse(body);
    const visit = await this.one('SELECT * FROM visits WHERE id=?', id);
    if (!visit) throw new ApiError(404, 'Invitación no encontrada.');
    const statements = [
      this.stmt(
        'UPDATE visits SET guest_name=?,invitation_note=?,access_mode=? WHERE id=?',
        p.guest_name,
        p.invitation_note,
        p.access_mode,
        id,
      ),
      this.audit('invitation.personalized', id),
    ];
    if (visit.batch_id)
      statements.push(
        this.stmt(
          `UPDATE people SET name=CASE WHEN ?<>'' THEN ? ELSE (SELECT name FROM invitation_batches WHERE id=?) || ' · Invitación ' || printf('%03d',?) END WHERE id=?`,
          p.guest_name,
          p.guest_name,
          visit.batch_id,
          visit.ticket_number,
          visit.person_id,
        ),
      );
    await this.db.batch(statements);
    return { ok: true };
  }
  async closeVisit(id: string, body: unknown) {
    this.require('operator');
    const p = z.object({ status: z.enum(['checked_out', 'cancelled']) }).parse(body);
    const visit = await this.one('SELECT * FROM visits WHERE id=?', id);
    if (!visit) throw new ApiError(404, 'Visita no encontrada.');
    if (visit.status === 'checked_out' || visit.status === 'cancelled')
      throw new ApiError(409, 'Esta visita ya está cerrada.');
    if (p.status === 'cancelled' && visit.status === 'checked_in')
      throw new ApiError(409, 'La visita ya ingresó: regístrala como salida.');
    const now = new Date();
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    const statements = [
      this.stmt(
        `INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,direction,method,allowed,reason,detail,actor,occurred_at,local_date)
        SELECT 'invitation-close:' || ? || ':' || e.zone_id,'',e.person_id,e.person_name,e.zone_id,e.zone_name,'exit','manual',1,'OK',
          'Salida de invitación confirmada por recepción',?,?,?
        FROM (${presenceSql}) e WHERE e.person_id=? AND ?='checked_out'
        ON CONFLICT(request_key) DO NOTHING`,
        id,
        this.actor.email,
        now.getTime(),
        localParts(now, settings!.timezone).date,
        visit.person_id,
        p.status,
      ),
      this.stmt('UPDATE visits SET status=?,checked_out_at=? WHERE id=?', p.status, Date.now(), id),
      this.audit('visit.' + p.status, id),
    ];
    // The visit credential must stop working the moment the visit ends.
    if (visit.credential_id)
      statements.push(this.stmt('UPDATE credentials SET active=0 WHERE id=?', visit.credential_id));
    await this.db.batch(statements);
    return { ok: true };
  }
  /** Revokes expired passes; a confirmed departure is still required for anyone inside. */
  async closeExpiredVisits(at = new Date()) {
    const settings = await this.one('SELECT timezone FROM settings WHERE id=1');
    if (!settings) return { closed: 0 };
    const today = localParts(at, settings.timezone).date;
    const results = await this.db.batch([
      this.stmt(
        `UPDATE credentials SET active=0 WHERE id IN(
        SELECT credential_id FROM visits WHERE expected_date<? AND status IN('expected','checked_in'))`,
        today,
      ),
      this.stmt(
        `UPDATE visits SET status='checked_out',checked_out_at=?
        WHERE expected_date<? AND status IN('expected','checked_in')
          AND NOT EXISTS(SELECT 1 FROM (${presenceSql}) inside WHERE inside.person_id=visits.person_id)`,
        at.getTime(),
        today,
      ),
    ]);
    const result = results[1] as { changes?: number; meta?: { changes: number } };
    return { closed: Number(result.changes ?? result.meta?.changes ?? 0) };
  }

  // ---- Blocklist ----------------------------------------------------------

  async blocklist() {
    this.require('admin');
    return this.all('SELECT document,reason,created_at,created_by FROM blocklist ORDER BY created_at DESC LIMIT 500');
  }
  async blockDocument(body: unknown) {
    this.require('admin');
    const p = z.object({ document: text, reason: z.string().trim().min(3).max(300) }).parse(body);
    await this.db.batch([
      this.stmt(
        'INSERT INTO blocklist(document,reason,created_at,created_by) VALUES(?,?,?,?) ON CONFLICT(document) DO UPDATE SET reason=excluded.reason',
        p.document,
        p.reason,
        Date.now(),
        this.actor.email,
      ),
      this.audit('blocklist.added', p.document),
    ]);
    return { ok: true };
  }
  async unblockDocument(document: string) {
    this.require('admin');
    await this.db.batch([
      this.stmt('DELETE FROM blocklist WHERE document=?', document),
      this.audit('blocklist.removed', document),
    ]);
    return { ok: true };
  }

  // ---- Alerts -------------------------------------------------------------

  /**
   * Alerts are computed from live state rather than stored, so they disappear on their own once
   * the condition clears. Only the per-user read mark is persisted, keyed by a stable key.
   */
  async alerts(at = new Date()) {
    const settings = await this.one('SELECT timezone,name FROM settings WHERE id=1');
    const timezone = settings!.timezone as string;
    const settingsName = settings!.name as string;
    const local = localParts(at, timezone);
    const now = at.getTime();
    const alerts: {
      key: string;
      kind: string;
      severity: 'info' | 'warning' | 'danger';
      title: string;
      detail: string;
      at: number;
      href?: string;
      whatsapp?: { phone: string; text: string };
    }[] = [];

    const [zones, denied, expiring, devices, overstays, afterHours] = await Promise.all([
      this.all(
        `SELECT z.id,z.name,z.capacity,(SELECT COUNT(*) FROM (${presenceSql}) p WHERE p.zone_id=z.id) inside
         FROM zones z WHERE z.active=1 AND z.capacity>0`,
      ),
      this.all(
        'SELECT zone_id,zone_name,COUNT(*) total,MAX(occurred_at) last FROM events WHERE allowed=0 AND occurred_at>? GROUP BY zone_id HAVING total>=5',
        now - 15 * 60000,
      ),
      this.all(
        `SELECT p.id,p.name,p.phone,p.expires FROM ${effectivePeopleSql(local.date)} p LEFT JOIN renewal_contacts r ON r.person_id=p.id AND r.expires=p.expires WHERE p.status='active' AND p.expires IS NOT NULL AND p.expires>=? AND p.expires<=? AND r.person_id IS NULL ORDER BY p.expires LIMIT 40`,
        local.date,
        nextDate(local.date, 7),
      ),
      this.all(
        'SELECT id,name,last_seen FROM devices WHERE active=1 AND last_seen IS NOT NULL AND last_seen<?',
        now - 30 * 60000,
      ),
      this.all(
        `SELECT v.id,v.expected_to,v.host_name,p.name person_name FROM visits v JOIN people p ON p.id=v.person_id
         WHERE v.status='checked_in' AND (v.expected_date<? OR (v.expected_date=? AND v.expected_to<?)) LIMIT 20`,
        local.date,
        local.date,
        local.time,
      ),
      this.all(
        `SELECT e.person_id,e.person_name,e.zone_name,e.occurred_at,s.start,s.end,s.days
         FROM (${presenceSql}) e JOIN people p ON p.id=e.person_id JOIN schedules s ON s.id=p.schedule_id LIMIT 200`,
      ),
    ]);

    for (const zone of zones) {
      if (zone.inside >= zone.capacity)
        alerts.push({
          key: `capacity-full:${zone.id}:${local.date}`,
          kind: 'capacity',
          severity: 'danger',
          title: `${zone.name} alcanzó su aforo`,
          detail: `${zone.inside} de ${zone.capacity} personas dentro. Las nuevas entradas serán rechazadas.`,
          at: now,
          href: '#access',
        });
      else if (zone.inside / zone.capacity >= 0.9)
        alerts.push({
          key: `capacity-near:${zone.id}:${local.date}`,
          kind: 'capacity',
          severity: 'warning',
          title: `${zone.name} está casi lleno`,
          detail: `${zone.inside} de ${zone.capacity} personas dentro.`,
          at: now,
          href: '#access',
        });
    }
    for (const row of denied)
      alerts.push({
        key: `denied-streak:${row.zone_id}:${Math.floor(row.last / 900000)}`,
        kind: 'denied',
        severity: 'warning',
        title: `${row.total} accesos denegados en ${row.zone_name}`,
        detail: 'Varios intentos rechazados en los últimos 15 minutos.',
        at: row.last,
        href: '#events',
      });
    for (const person of expiring) {
      // Whole days between today and the expiry date, both read in the organization's timezone.
      const days = remainingDays(person.expires, local.date);
      const whenLabel = days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
      alerts.push({
        key: `credential-expiring:${person.id}:${person.expires}:${days}`,
        kind: 'expiring',
        // Three days out it stops being a note and becomes something to act on.
        severity: days <= 3 ? 'warning' : 'info',
        title: `El permiso de ${person.name} vence ${whenLabel}`,
        detail:
          (days <= 3 ? `Quedan ${days === 0 ? 'menos de un día' : days === 1 ? '1 día' : days + ' días'}. ` : '') +
          `Vence el ${person.expires}. ` +
          (person.phone ? 'Puedes avisarle por WhatsApp.' : 'No tiene teléfono registrado para avisarle.'),
        at: now,
        href: this.actor.role === 'admin' ? '#renewals' : '#people',
        ...(person.phone && days <= 3 && this.actor.role === 'admin'
          ? {
              whatsapp: {
                phone: person.phone,
                text: renewalMessage(person.name, settingsName, person.expires, days),
              },
            }
          : {}),
      });
    }
    for (const device of devices)
      alerts.push({
        key: `device-offline:${device.id}:${Math.floor(device.last_seen / 3600000)}`,
        kind: 'device',
        severity: 'warning',
        title: `El lector ${device.name} no responde`,
        detail: `Sin conexión desde hace más de 30 minutos.`,
        at: device.last_seen,
        href: '#settings',
      });
    for (const visit of overstays)
      alerts.push({
        key: `visit-overstay:${visit.id}`,
        kind: 'visit',
        severity: 'warning',
        title: `${visit.person_name} sigue dentro`,
        detail: `Su visita terminaba a las ${visit.expected_to}. Anfitrión: ${visit.host_name}.`,
        at: now,
        href: '#visits',
      });
    for (const row of afterHours) {
      const days: number[] = JSON.parse(row.days);
      const inside = withinSchedule(days, row.start, row.end, local.time, local.day);
      if (!inside && row.start !== row.end)
        alerts.push({
          key: `after-hours:${row.person_id}:${local.date}`,
          kind: 'after-hours',
          severity: 'info',
          title: `${row.person_name} está dentro fuera de su horario`,
          detail: `${row.zone_name} · horario ${row.start}–${row.end}.`,
          at: row.occurred_at,
          href: '#access',
        });
    }

    const read = await this.all('SELECT alert_key FROM alert_reads WHERE user_id=?', this.actor.id);
    const seen = new Set(read.map((row) => row.alert_key));
    const rows = alerts
      .map((alert) => ({ ...alert, read: seen.has(alert.key) }))
      .sort((a, b) => Number(a.read) - Number(b.read) || b.at - a.at);
    return { alerts: rows, unread: rows.filter((alert) => !alert.read).length };
  }
  async readAlerts(body: unknown) {
    const p = z.object({ keys: z.array(z.string().max(200)).max(100) }).parse(body);
    if (!p.keys.length) return { ok: true };
    await this.db.batch([
      // Keep the table small: a read mark is only useful while its alert still exists.
      this.stmt('DELETE FROM alert_reads WHERE user_id=? AND read_at<?', this.actor.id, Date.now() - 30 * 86400000),
      ...p.keys.map((key) =>
        this.stmt(
          'INSERT INTO alert_reads(user_id,alert_key,read_at) VALUES(?,?,?) ON CONFLICT(user_id,alert_key) DO NOTHING',
          this.actor.id,
          key,
          Date.now(),
        ),
      ),
    ]);
    return { ok: true };
  }

  // ---- Saved reports ------------------------------------------------------

  async savedReports() {
    return this.all(
      'SELECT id,name,kind,query,created_at FROM saved_reports WHERE owner=? ORDER BY kind,name LIMIT 100',
      this.actor.email,
    );
  }
  async saveReport(body: unknown) {
    const p = z
      .object({ name: text, kind: z.enum(['events', 'workdays', 'visits']), query: z.string().max(500) })
      .parse(body);
    const existing = await this.one('SELECT COUNT(*) total FROM saved_reports WHERE owner=?', this.actor.email);
    if (Number(existing!.total) >= 100) throw new ApiError(400, 'Has alcanzado el máximo de 100 reportes guardados.');
    const id = crypto.randomUUID();
    await this.stmt(
      'INSERT INTO saved_reports(id,owner,name,kind,query,created_at) VALUES(?,?,?,?,?,?)',
      id,
      this.actor.email,
      p.name,
      p.kind,
      p.query,
      Date.now(),
    ).run();
    return { id };
  }
  async deleteReport(id: string) {
    const result = await this.stmt('DELETE FROM saved_reports WHERE id=? AND owner=?', id, this.actor.email).run();
    if (!result.meta.changes) throw new ApiError(404, 'Reporte no encontrado.');
    return { ok: true };
  }

  async closeStaleSessions(at = new Date()) {
    this.require('admin');
    const settings = await this.one('SELECT timezone,auto_close_hours,closing_time FROM settings WHERE id=1');
    if (!settings || (!settings.closing_time && !settings.auto_close_hours)) return { closed: 0 };
    const closing = settings.closing_time || null;
    const duration = settings.auto_close_hours * 3600000;
    const times = new Map<string, number>();
    const daily = (date: string) => {
      if (!times.has(date)) times.set(date, closingInstant(date, closing!, settings.timezone));
      return times.get(date)!;
    };
    const today = localParts(at, settings.timezone).date;
    const cutoff = closing
      ? daily(today) <= at.getTime()
        ? daily(today)
        : daily(nextDate(today, -1))
      : at.getTime() - duration;
    let closed = 0;
    for (;;) {
      const entries = await this.all(
        `SELECT * FROM (${presenceSql}) WHERE occurred_at${closing ? '<' : '<='}? ORDER BY id LIMIT 500`,
        cutoff,
      );
      if (!entries.length) break;
      const statements = await Promise.all(
        entries.map(async (entry) => {
          const date = localParts(new Date(entry.occurred_at), settings.timezone).date;
          const exitAt = closing
            ? daily(date) > entry.occurred_at
              ? daily(date)
              : daily(nextDate(date))
            : entry.occurred_at + duration;
          return this.stmt(
            `INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,direction,method,allowed,reason,detail,actor,device_id,occurred_at,local_date)
          SELECT ?,?,e.person_id,e.person_name,e.zone_id,e.zone_name,'exit','system',1,'AUTO_CLOSE',?,'system',NULL,?,?
          FROM events e WHERE e.id=? AND e.allowed=1 AND e.direction='entry'
          AND NOT EXISTS(SELECT 1 FROM events later WHERE later.person_id=e.person_id AND later.zone_id=e.zone_id AND later.allowed=1 AND (later.occurred_at>e.occurred_at OR (later.occurred_at=e.occurred_at AND later.id>e.id)))
          AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND auto_close_hours=? AND timezone=? AND closing_time IS ?)
          ON CONFLICT(request_key) DO NOTHING`,
            'auto-close:' + entry.id,
            await hash(JSON.stringify(['AUTO_CLOSE', entry.id, exitAt])),
            closing
              ? `Salida automática estimada al cierre de las ${closing} (${settings.timezone}).`
              : `Salida estimada tras ${settings.auto_close_hours} horas sin salida registrada.`,
            exitAt,
            localParts(new Date(exitAt), settings.timezone).date,
            entry.id,
            settings.auto_close_hours,
            settings.timezone,
            closing,
          );
        }),
      );
      // Re-check presence inside each INSERT, under the same write lock as the entire batch.
      const results = await this.db.batch(statements);
      const changes = results.reduce<number>(
        (sum, result) => sum + Number((result as { changes: number | bigint }).changes),
        0,
      );
      closed += changes;
      if (!changes) break;
    }
    return { closed };
  }
  async updateSettings(body: unknown) {
    this.require('admin');
    const p = z
      .object({
        name: text.optional(),
        timezone: text.optional(),
        auto_close_hours: z.number().int().min(0).max(720).optional(),
        closing_time: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
          .nullable()
          .optional(),
        /** Aforo del gimnasio: 0 no limita. Se aplica al área general, que es la que usa la recepción. */
        capacity: z.number().int().min(0).max(100000).optional(),
        brand_color: z
          .string()
          .regex(/^#[\da-f]{6}$/i)
          .optional(),
        /** Tamaño de la marca de agua del logo, como porcentaje del lado corto de la ventana. */
        logo_watermark_size: z.number().int().min(10).max(100).optional(),
        /** Color de la franja superior de las credenciales; null vuelve al color de GymPASS. */
        credential_color: z
          .string()
          .regex(/^#[\da-f]{6}$/i)
          .nullable()
          .optional(),
        /** Lado de la marca de agua de la credencial, como porcentaje del ancho de la tarjeta. */
        credential_watermark_size: z.number().int().min(10).max(100).optional(),
      })
      .refine((value) => Object.values(value).some((field) => field !== undefined), 'Envía al menos un ajuste.')
      .parse(body);
    if (p.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: p.timezone });
      } catch {
        throw new ApiError(400, 'Zona horaria inválida.');
      }
    }
    await this.db.batch([
      ...(p.name !== undefined ? [this.stmt('UPDATE settings SET name=? WHERE id=1', p.name)] : []),
      ...(p.timezone !== undefined ? [this.stmt('UPDATE settings SET timezone=? WHERE id=1', p.timezone)] : []),
      ...(p.brand_color
        ? [this.stmt('UPDATE settings SET brand_color=? WHERE id=1', p.brand_color.toLowerCase())]
        : []),
      ...(p.credential_color !== undefined
        ? [this.stmt('UPDATE settings SET credential_color=? WHERE id=1', p.credential_color?.toLowerCase() ?? null)]
        : []),
      ...(p.credential_watermark_size !== undefined
        ? [this.stmt('UPDATE settings SET credential_watermark_size=? WHERE id=1', p.credential_watermark_size)]
        : []),
      ...(p.logo_watermark_size !== undefined
        ? [this.stmt('UPDATE settings SET logo_watermark_size=? WHERE id=1', p.logo_watermark_size)]
        : []),
      ...(p.auto_close_hours !== undefined
        ? [this.stmt('UPDATE settings SET auto_close_hours=? WHERE id=1', p.auto_close_hours)]
        : []),
      ...(p.closing_time !== undefined
        ? [this.stmt('UPDATE settings SET closing_time=? WHERE id=1', p.closing_time)]
        : []),
      ...(p.capacity !== undefined
        ? [this.stmt('UPDATE zones SET capacity=? WHERE id=?', p.capacity, generalAccessId)]
        : []),
      this.audit('settings.updated', '1'),
    ]);
    return { ok: true };
  }
  async saveMember(body: unknown, passwordHash?: string) {
    this.require('admin');
    const p = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .max(200)
          .transform((v) => v.toLowerCase()),
        name: text,
        role: z.enum(['admin', 'operator', 'viewer']),
        active: z.number().int().min(0).max(1),
      })
      .parse(body);
    const existing = await this.one('SELECT * FROM members WHERE email=?', p.email);
    const settings = await this.one('SELECT owner FROM settings WHERE id=1');
    if (existing?.user_id === settings!.owner && (p.role !== 'admin' || p.active !== 1))
      throw new ApiError(400, 'El propietario debe conservar su acceso de administrador.');
    if (!existing && !passwordHash) throw new ApiError(400, 'Establece una contraseña para el nuevo usuario.');
    const userId = existing?.user_id || crypto.randomUUID();
    const statements = [
      this.stmt(
        'INSERT INTO members(email,user_id,name,role,active,password_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,active=excluded.active,password_hash=excluded.password_hash',
        p.email,
        userId,
        p.name,
        p.role,
        p.active,
        passwordHash || existing!.password_hash,
      ),
      this.audit('member.updated', p.email),
    ];
    if (passwordHash || p.active === 0) statements.push(this.stmt('DELETE FROM sessions WHERE user_id=?', userId));
    await this.db.batch(statements);
    return { ok: true };
  }
}
export { toCsv } from './csv.ts';
