import { z } from 'zod';
import { ApiError, Service, hash } from './service.ts';
import { localParts } from './domain.ts';

export async function correctOfflineSession(s: Service, body: unknown, now = Date.now()) {
  s.require('admin');
  const stamp = z.number().int().min(0).max(8640000000000000);
  const input = z.object({ entry_id: z.number().int().positive(), entry_at: stamp, exit_at: stamp.nullable(), reason: z.string().trim().min(1).max(1000) }).parse(body);
  if (input.entry_at > now || input.exit_at !== null && (input.exit_at > now || input.exit_at < input.entry_at)) throw new ApiError(400, 'Las horas no pueden estar en el futuro y la salida debe ser posterior a la entrada.');
  const entry = await s.one('SELECT * FROM events WHERE id=?', input.entry_id);
  if (!entry || entry.allowed !== 1 || entry.direction !== 'entry' || !entry.person_id) throw new ApiError(404, 'No se encontró una entrada permitida.');
  const next = await s.one('SELECT * FROM events WHERE person_id=? AND zone_id=? AND allowed=1 AND id>? ORDER BY id LIMIT 1', entry.person_id, entry.zone_id, entry.id);
  const exit = next?.direction === 'exit' ? next : null;
  if (!exit && next) throw new ApiError(400, 'La visita abierta debe ser el último movimiento de la persona.');
  if (exit && input.exit_at === null) throw new ApiError(400, 'No se puede eliminar una salida registrada.');
  const previous = await s.one('SELECT occurred_at FROM events WHERE person_id=? AND zone_id=? AND allowed=1 AND id<? ORDER BY id DESC LIMIT 1', entry.person_id, entry.zone_id, entry.id);
  const following = exit ? await s.one('SELECT occurred_at FROM events WHERE person_id=? AND zone_id=? AND allowed=1 AND id>? ORDER BY id LIMIT 1', entry.person_id, entry.zone_id, exit.id) : null;
  if (previous && input.entry_at < previous.occurred_at || following && input.exit_at !== null && input.exit_at > following.occurred_at) throw new ApiError(400, 'Las horas deben quedar entre los movimientos anterior y siguiente.');
  const settings = await s.one('SELECT timezone FROM settings WHERE id=1');
  const date = (at: number) => localParts(new Date(at), settings!.timezone).date;
  const statements = [s.stmt('UPDATE events SET occurred_at=?,local_date=? WHERE id=?', input.entry_at, date(input.entry_at), entry.id)];
  const request = 'correction_' + crypto.randomUUID();
  if (input.exit_at !== null) {
    if (exit) statements.push(s.stmt("UPDATE events SET occurred_at=?,local_date=?,reason='MANUAL_CORRECTION',detail=? WHERE id=?", input.exit_at, date(input.exit_at), input.reason, exit.id));
    else statements.push(s.stmt("INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,direction,method,allowed,reason,detail,actor,occurred_at,local_date) VALUES(?,?,?,?,?,?,'exit','manual',1,'MANUAL_CORRECTION',?,?,?,?)", request, await hash(JSON.stringify(input)), entry.person_id, entry.person_name, entry.zone_id, entry.zone_name, input.reason, s.actor.email, input.exit_at, date(input.exit_at)));
  }
  statements.push(s.audit('gym_session.corrected', JSON.stringify({ entry_id: entry.id, actor: s.actor, reason: input.reason, before: { entry, exit }, after: { entry_at: input.entry_at, exit_at: input.exit_at, exit_id: exit?.id, exit_request_key: exit ? exit.request_key : request } })));
  await s.db.batch(statements);
  return { ok: true };
}
