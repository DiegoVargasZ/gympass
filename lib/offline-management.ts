import { ApiError, Service, presenceSql, toCsv } from './service.ts';
import { PosService } from './pos.ts';
import { kindLabels, reasons } from './domain.ts';
import { correctOfflineSession } from './offline-session-correction.ts';

export type LocalResponse = { data?: unknown; status?: number; text?: string; mime?: string };

/** Uses the same permissions, validation and transactions as the central application. */
export async function offlineManagement(s: Service, path: string, method = 'GET', body: any = {}): Promise<LocalResponse> {
  const url = new URL(path, 'https://local/');
  const parts = url.pathname.replace(/^\//, '').split('/');
  const [first, id, action] = parts;
  const params = url.searchParams;
  const send = (data: unknown): LocalResponse => ({ data });
  if (method === 'GET' && ['events', 'gym-sessions', 'attendance', 'workdays', 'payroll', 'saved-reports', 'periods'].includes(first)) s.requireReports();
  if (['attendance', 'workdays', 'payroll', 'periods', 'calendar', 'visits', 'invitation-batches', 'invitation-templates'].includes(first) && method !== 'GET')
    throw new ApiError(410, 'Este módulo fue retirado. Sus datos históricos se conservan.');
  if (first === 'pos') {
    const pos = new PosService(s);
    if (method === 'GET') {
      if (id === 'catalog') return send(await pos.catalog());
      if (id === 'reports') return send(await pos.report(params));
      if (id === 'sales') return send(action ? await pos.sale(action) : await pos.sales(params));
      if (id === 'memberships' && action) return send(await pos.memberships(action));
    }
    if (method === 'POST') {
      if (id === 'checkout') return send(await pos.checkout(body));
      if (id === 'products' && parts[3] === 'stock') return send(await pos.adjustStock(action, body));
      if (id === 'sales' && parts[3] === 'void') return send(await pos.voidSale(action, body));
      if (id === 'products' && !action) return send(await pos.saveProduct(body));
      if (id === 'plans' && !action) return send(await pos.savePlan(body));
    }
    if (method === 'PATCH') {
      if (id === 'products' && action) return send(await pos.saveProduct(body, action));
      if (id === 'plans' && action) return send(await pos.savePlan(body, action));
    }
  }
  if (method === 'GET') {
    if (first === 'people' && action === 'credentials') return send(await s.credentials(id));
    if (first === 'people' && action === 'summary') return send(await s.personSummary(id));
    if (first === 'people') return send(id ? await s.personDetail(id) : await s.peopleList(params));
    if (first === 'credentials' && action === 'card') return send(await s.credentialCard(id));
    if (first === 'credentials') return send(await s.credentialList(params));
    if (first === 'presence') return send(await s.all(`SELECT e.*,p.document,p.department,p.photo_path FROM (${presenceSql}) e JOIN people p ON p.id=e.person_id ORDER BY e.occurred_at DESC`));
    if (first === 'devices') return send(await s.devices());
    if (first === 'audit') { s.require('admin'); return send(await s.all('SELECT * FROM audit ORDER BY id DESC LIMIT 100')); }
    if (first === 'expirations') return send(await s.expirations(params));
    if (first === 'blocklist') return send(await s.blocklist());
    if (first === 'alerts') return send(await s.alerts());
    if (first === 'saved-reports') return send(await s.savedReports());
    if (first === 'calendar') return send(await s.calendarExceptions(params));
    if (first === 'periods') return send(await s.attendancePeriods());
    if (first === 'visits') return send(action === 'pass' ? await s.visitPass(id) : await s.visits(params));
    if (first === 'events') {
      const report = await s.eventList(params, id === 'export');
      return id !== 'export' ? send(report) : { mime: 'text/csv; charset=utf-8', text: toCsv(['Fecha UTC', 'Persona', 'Zona', 'Movimiento', 'Método', 'Resultado', 'Motivo', 'Detalle', 'Operador'], report.rows.map(r => [new Date(r.occurred_at).toISOString(), r.person_name, r.zone_name, r.direction === 'entry' ? 'Entrada' : 'Salida', kindLabels[r.method], r.allowed ? 'Permitido' : 'Denegado', reasons[r.reason], r.detail, r.actor])) };
    }
    if (first === 'gym-sessions') {
      const report = await s.gymSessions(params);
      return id !== 'export' ? send(report) : { mime: 'text/csv; charset=utf-8', text: toCsv(['Socio', 'Zona', 'Fecha', 'Entrada UTC', 'Salida UTC', 'Minutos', 'Estado'], report.rows.map(r => [r.person_name, r.zone_name, r.local_date, new Date(r.entry_at).toISOString(), r.exit_at === null ? '' : new Date(r.exit_at).toISOString(), r.exit_at === null ? '' : Math.max(0, Math.floor((r.exit_at - r.entry_at) / 60000)), r.exit_at === null ? 'Dentro' : r.auto_closed ? 'Salida estimada' : 'Finalizada'])) };
    }
    if (first === 'attendance') return send(await s.attendance(params));
    if (first === 'workdays' || first === 'payroll') return send(await s.attendanceReport(params));
  }
  if (method === 'POST') {
    if (first === 'gym-sessions' && action === 'correct') return send(await correctOfflineSession(s, { ...body, entry_id: Number(id) }));
    if (first === 'access') return send(await s.access(body));
    if (first === 'people' && action === 'restore') return send(await s.restorePerson(id));
    if (first === 'people' && action === 'credentials') return send(await s.issueCredential(id, body));
    if (first === 'people' && !id) return send(await s.savePerson(body));
    if (first === 'devices') return send(await s.createDevice(body));
    if (first === 'expirations' && id) return send(await s.markRenewal(id, body));
    if (first === 'blocklist') return send(await s.blockDocument(body));
    if (first === 'alerts' && id === 'read') return send(await s.readAlerts(body));
    if (first === 'saved-reports') return send(await s.saveReport(body));
  }
  if (method === 'PATCH') {
    if (first === 'people' && id) return send(await s.savePerson(body, id));
    if (first === 'credentials' && id) return send(await s.revokeCredential(id));
    if (first === 'devices' && id) return send(await s.revokeDevice(id));
    if (first === 'settings') return send(await s.updateSettings(body));
  }
  if (method === 'DELETE') {
    if (first === 'blocklist' && id) return send(await s.unblockDocument(decodeURIComponent(id)));
    if (first === 'saved-reports' && id) return send(await s.deleteReport(id));
    if (first === 'people' && id && !action) return send(await s.deletePerson(id));
  }
  throw new ApiError(404, 'Operación no disponible en la copia local.');
}
