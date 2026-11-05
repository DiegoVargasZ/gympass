import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError, Service, presenceSql, toCsv, hash } from '../lib/service.ts';
import { kindLabels, reasons } from '../lib/domain.ts';
import { InvitationBatches } from '../lib/invitation-batches.ts';
import { invitationBackground } from './invitation-backgrounds.ts';
import { loadMedia, saveMedia } from './media.ts';
import { applicationVersion } from './backups.ts';
import { correctSessionTimes } from './session-corrections.ts';
import { verifyPassword } from './auth.ts';
import type { PlatformStore, GymAuthorization } from './platform-store.ts';
import type { TenantContext, TenantManager } from './tenant-manager.ts';
import { json, readJson } from './platform-http.ts';
import { authorizedDatabase } from './authorized-database.ts';
import { posRequest } from './pos-api.ts';

export async function gymApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string[],
  ctx: TenantContext,
  auth: GymAuthorization,
  store: PlatformStore,
  manager: TenantManager,
  reauthorize: () => void,
) {
  const method = req.method || 'GET';
  const s = new Service(authorizedDatabase(ctx.db, reauthorize), auth.actor, ctx.codec);
  const first = path[0],
    id = path[1],
    action = path[2];
  const imageUpload = method === 'PUT' && ((first === 'people' && action === 'photo') || first === 'branding');
  const background = ['invitation-batches', 'visits'].includes(first) && !!id && action === 'background';
  const body = method === 'GET' || imageUpload || background ? {} : await readJson(req);
  reauthorize();
  const send = (value: unknown, status = 200) => json(res, value, status);
  if (first === 'pos') {
    const result = await posRequest(s, method, path, body, url.searchParams);
    return send(result.data, result.status);
  }
  const csv = (name: string, columns: string[], rows: unknown[][]) => {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end(toCsv(columns, rows));
  };
  if (background && ['GET', 'PUT', 'DELETE'].includes(method))
    return send(await invitationBackground(s, ctx.root, first as 'visits' | 'invitation-batches', id, req));
  if (imageUpload) return send(await saveMedia(s, ctx.root, req, first === 'people' ? id : undefined));
  if (first === 'auth' && id === 'status' && method === 'GET') return send({ setupRequired: false, user: auth.actor });
  if (first === 'system-info' && method === 'GET')
    return send({ version: applicationVersion, desktop: false, mode: 'platform' });
  if (first === 'branding' && method === 'GET') {
    const branding = await s.one('SELECT name,brand_color,logo_path FROM settings WHERE id=1');
    if (!id) return send(branding);
    if (id !== 'logo' || !branding?.logo_path) throw new ApiError(404, 'Sin logo configurado.');
    const bytes = await loadMedia(ctx.root, 'branding', branding.logo_path);
    res.writeHead(200, {
      'Content-Type': branding.logo_path.endsWith('.svg')
        ? 'image/svg+xml'
        : branding.logo_path.endsWith('.png')
          ? 'image/png'
          : 'image/webp',
      'Cache-Control': 'private,no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    reauthorize();
    return res.end(bytes);
  }
  if (first === 'backups') {
    if (auth.user.global_role !== 'superadmin' || !auth.support)
      throw new ApiError(403, 'Los respaldos de plataforma los gestiona el superadministrador.');
    if (method === 'GET') {
      if (!id) {
        const status = ctx.backups.status();
        return send({ ...status, directory: undefined, settings: { ...status.settings, directory: undefined } });
      }
      manager.verifyBackup(ctx, id);
      if (action === 'inspect') return send(ctx.backups.inspect(id));
      if (action === 'export') {
        const copy = ctx.backups.exportCopy(id);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${copy.filename}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(copy.bytes);
      }
    }
    if (method === 'POST' && !id) return send(ctx.backups.create(), 201);
    if (method === 'POST' && action === 'restore') {
      if (body.confirm !== 'RESTAURAR') throw new ApiError(400, 'Escribe RESTAURAR para continuar.');
      const owner = store.raw
        .prepare('SELECT password_hash FROM platform_users WHERE id=? AND active=1')
        .get(auth.user.id);
      if (
        !owner ||
        typeof body.password !== 'string' ||
        !(await verifyPassword(body.password, String(owner.password_hash)))
      )
        throw new ApiError(403, 'Confirma tu contraseña de superadministrador.');
      reauthorize();
      manager.verifyBackup(ctx, id);
      const result = ctx.backups.restore(id);
      ctx.reload = true;
      store.audit(auth.user.id, 'backup.restored', ctx.id, id);
      return send({ ...result, restart: false });
    }
    throw new ApiError(400, 'Operación de respaldo no disponible en plataforma.');
  }
  if (['activation', 'network', 'system'].includes(first) || first === 'auth')
    throw new ApiError(404, 'Esta operación pertenece al modo local.');
  if (method === 'GET') {
    const batches = new InvitationBatches(s);
    if (first === 'invitation-batches') {
      if (!id) return send(await batches.list(url.searchParams));
      if (action === 'passes') return send(await batches.passes(id));
      if (action === 'report') return send(await batches.report(id));
      return send(await batches.detail(id));
    }
    if (first === 'invitation-templates') return send(await batches.templates());
    if (first === 'bootstrap' || (first === 'mobile' && id === 'bootstrap')) {
      const boot = await s.bootstrap();
      if (first === 'mobile') {
        s.require('operator');
        return send({
          user: boot.user,
          installation_id: boot.installation_id,
          stats: boot.stats,
          today: boot.today,
          timezone: boot.settings!.timezone,
          gym_id: ctx.id,
          server_mode: 'platform',
          protocol: 1,
          platform: {
            gym_id: ctx.id,
            gym_name: auth.gym.name,
            support: false,
            superadmin: false,
            read_only: auth.readOnly,
          },
        });
      }
      return send({
        ...boot,
        version: applicationVersion,
        platform: {
          gym_id: ctx.id,
          gym_name: auth.gym.name,
          support: auth.support,
          superadmin: auth.user.global_role === 'superadmin',
          read_only: auth.readOnly,
        },
      });
    }
    if (first === 'mobile') {
      s.require('operator');
      if (id === 'people') return send(await s.peopleList(url.searchParams));
      if (id === 'events') return send(await s.eventList(url.searchParams));
      if (id === 'gym-sessions') return send(await s.gymSessions(url.searchParams));
      if (id === 'presence')
        return send(
          await s.all(
            `SELECT e.person_id,e.person_name,e.zone_name,e.occurred_at,p.document FROM (${presenceSql}) e JOIN people p ON p.id=e.person_id ORDER BY e.occurred_at DESC`,
          ),
        );
    }
    if (first === 'people' && action === 'photo') {
      const person = await s.one('SELECT photo_path FROM people WHERE id=?', id);
      if (!person?.photo_path) throw new ApiError(404, 'Esta persona no tiene foto.');
      const bytes = await loadMedia(ctx.root, 'photos', person.photo_path);
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private,no-store' });
      return res.end(bytes);
    }
    if (first === 'people' && action === 'credentials') return send(await s.credentials(id));
    if (first === 'people' && action === 'summary') return send(await s.personSummary(id));
    if (first === 'people') return send(id ? await s.personDetail(id) : await s.peopleList(url.searchParams));
    if (first === 'credentials' && action === 'card') return send(await s.credentialCard(id));
    if (first === 'credentials') return send(await s.credentialList(url.searchParams));
    if (first === 'presence')
      return send(
        await s.all(
          `SELECT e.*,p.document,p.department,p.photo_path FROM (${presenceSql}) e JOIN people p ON p.id=e.person_id ORDER BY e.occurred_at DESC`,
        ),
      );
    if (first === 'devices') return send(await s.devices());
    if (first === 'members') {
      s.require('admin');
      return send(store.listMembers(auth.user, ctx.id));
    }
    if (first === 'audit') {
      s.require('admin');
      return send(await s.all('SELECT * FROM audit ORDER BY id DESC LIMIT 100'));
    }
    if (first === 'expirations') return send(await s.expirations(url.searchParams));
    if (first === 'events') {
      const report = await s.eventList(url.searchParams, id === 'export');
      if (id !== 'export') return send(report);
      return csv(
        'accesos',
        ['Fecha UTC', 'Persona', 'Zona', 'Movimiento', 'Método', 'Resultado', 'Motivo', 'Detalle', 'Operador'],
        report.rows.map((r) => [
          new Date(r.occurred_at).toISOString(),
          r.person_name,
          r.zone_name,
          r.direction === 'entry' ? 'Entrada' : 'Salida',
          kindLabels[r.method],
          r.allowed ? 'Permitido' : 'Denegado',
          reasons[r.reason],
          r.detail,
          r.actor,
        ]),
      );
    }
    if (first === 'gym-sessions') {
      const report = await s.gymSessions(url.searchParams);
      if (id !== 'export') return send(report);
      return csv(
        'visitas-gimnasio',
        ['Socio', 'Zona', 'Fecha', 'Entrada UTC', 'Salida UTC', 'Minutos', 'Estado'],
        report.rows.map((r) => [
          r.person_name,
          r.zone_name,
          r.local_date,
          new Date(r.entry_at).toISOString(),
          r.exit_at === null ? '' : new Date(r.exit_at).toISOString(),
          r.exit_at === null ? '' : Math.max(0, Math.floor((r.exit_at - r.entry_at) / 60000)),
          r.exit_at === null ? 'Dentro' : r.auto_closed ? 'Salida estimada' : 'Finalizada',
        ]),
      );
    }
    if (first === 'attendance') {
      const report = await s.attendance(url.searchParams);
      if (id !== 'export') return send(report);
      return csv(
        'asistencia',
        [
          'Fecha',
          'Persona',
          'Zonas',
          'Primera entrada UTC',
          'Última salida UTC',
          'Minutos',
          'Abiertas',
          'Cierres automáticos',
        ],
        report.rows.map((r) => [
          r.date,
          r.name,
          r.zones.join(' / '),
          new Date(r.first).toISOString(),
          r.last ? new Date(r.last).toISOString() : '',
          r.minutes,
          r.open,
          r.auto_closed,
        ]),
      );
    }
    if (first === 'workdays' || first === 'payroll') {
      const report = await s.attendanceReport(url.searchParams);
      if (first === 'workdays' && id !== 'export') return send(report);
      return csv(
        first === 'payroll' ? 'planilla' : 'jornadas',
        ['Persona', 'Documento', 'Área', 'Días trabajados', 'Minutos', 'Minutos esperados', 'Minutos extra'],
        report.people.map((p) => [
          p.name,
          p.document,
          p.department,
          p.totals.worked_days,
          p.totals.minutes,
          p.totals.expected_minutes,
          p.totals.overtime_minutes,
        ]),
      );
    }
    if (first === 'visits') return send(action === 'pass' ? await s.visitPass(id) : await s.visits(url.searchParams));
    if (first === 'blocklist') return send(await s.blocklist());
    if (first === 'alerts') return send(await s.alerts());
    if (first === 'saved-reports') return send(await s.savedReports());
    if (first === 'calendar') return send(await s.calendarExceptions(url.searchParams));
    if (first === 'periods') return send(await s.attendancePeriods());
  }
  if (method === 'POST') {
    if (first === 'gym-sessions' && action === 'correct')
      return send(correctSessionTimes(ctx.db, auth.actor, { ...body, entry_id: Number(id) }, Date.now(), auth.actor));
    if (first === 'access') {
      const event = await s.access(body);
      const person = event.person_id ? await s.one('SELECT photo_path FROM people WHERE id=?', event.person_id) : null;
      return send({ ...event, photo_path: person?.photo_path ?? null });
    }
    if (first === 'people' && id && action === 'restore') return send(await s.restorePerson(id));
    if (first === 'people' && action === 'credentials') return send(await s.issueCredential(id, body), 201);
    if (first === 'people' && !id) return send(await s.savePerson(body), 201);
    if (first === 'devices') return send(await s.createDevice(body), 201);
    if (first === 'expirations' && id) return send(await s.markRenewal(id, body));
    if (first === 'visits' && action === 'check-in') return send(await s.checkInVisit(id, body), 201);
    if (first === 'visits' && action === 'close') return send(await s.closeVisit(id, body));
    if (first === 'visits' && !id) return send(await s.saveVisit(body), 201);
    if (first === 'blocklist') return send(await s.blockDocument(body), 201);
    if (first === 'alerts' && id === 'read') return send(await s.readAlerts(body));
    if (first === 'saved-reports') return send(await s.saveReport(body), 201);
    if (first === 'calendar') return send(await s.saveException(body), 201);
    if (first === 'periods') return send(await s.setPeriod(body));
    if (first === 'invitation-batches') {
      const b = new InvitationBatches(s);
      if (!id) return send(await b.create(body), 201);
      if (action === 'append') return send(await b.append(id, body));
      if (action === 'import') return send(await b.importGuests(id, body));
      if (action === 'duplicate') return send(await b.duplicate(id, body), 201);
      if (action === 'templates') return send(await b.saveTemplate(id, body), 201);
      if (action === 'template') return send(await b.applyTemplate(id, z.string().uuid().parse(body.template_id)));
    }
  }
  if (method === 'PATCH') {
    if (first === 'people' && id) return send(await s.savePerson(body, id));
    if (first === 'credentials' && id) return send(await s.revokeCredential(id));
    if (first === 'devices' && id) return send(await s.revokeDevice(id));
    if (first === 'settings') return send(await s.updateSettings(body));
    if (first === 'invitation-batches') {
      const b = new InvitationBatches(s);
      if (action === 'archive') return send(await b.archive(id, body));
      if (action === 'delivery') return send(await b.delivery(id, body));
      if (id && !action) return send(await b.update(id, body));
    }
    if (first === 'visits' && action === 'invitation') return send(await s.personalizeInvitation(id, body));
  }
  if (method === 'DELETE') {
    if (first === 'invitation-templates' && id) return send(await new InvitationBatches(s).deleteTemplate(id));
    if (first === 'calendar' && id) return send(await s.deleteException(id));
    if (first === 'blocklist' && id) return send(await s.unblockDocument(decodeURIComponent(id)));
    if (first === 'saved-reports' && id) return send(await s.deleteReport(id));
    if (first === 'people' && id && !action) return send(await s.deletePerson(id));
  }
  throw new ApiError(404, 'Ruta no encontrada.');
}
