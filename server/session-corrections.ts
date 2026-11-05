import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localParts } from '../lib/domain.ts';
import { ApiError, type Actor } from '../lib/service.ts';
import type { SqliteDatabase } from './database.ts';

const timestamp = z.number().int().min(0).max(8640000000000000);
const correction = z.object({
  entry_id: z.number().int().positive(),
  entry_at: timestamp,
  exit_at: timestamp.nullable(),
  reason: z.string().trim().min(1).max(1000),
});
type Movement = {
  id: number;
  person_id: string | null;
  person_name: string;
  zone_id: string;
  zone_name: string;
  direction: string;
  allowed: number;
  occurred_at: number;
};

export function correctSessionTimes(
  db: SqliteDatabase,
  actor: Actor,
  body: unknown,
  now = Date.now(),
  platformActor?: Actor,
): { ok: true } {
  const sql = db.raw;
  sql.exec('BEGIN IMMEDIATE');
  try {
    const member =
      platformActor?.id === actor.id && platformActor.role === 'admin'
        ? platformActor
        : sql
            .prepare("SELECT user_id id,email,name,role FROM members WHERE user_id=? AND role='admin' AND active=1")
            .get(actor.id);
    if (actor.role !== 'admin' || !member)
      throw new ApiError(403, 'Solo un administrador activo puede corregir las horas.');
    const parsed = correction.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'Indica horas válidas y un motivo de entre 1 y 1000 caracteres.');
    const input = parsed.data;
    if (input.entry_at > now || (input.exit_at !== null && (input.exit_at > now || input.exit_at < input.entry_at)))
      throw new ApiError(
        400,
        'Las horas no pueden estar en el futuro y la salida debe ser igual o posterior a la entrada.',
      );
    const read = sql.prepare('SELECT * FROM events WHERE id=?');
    const entry = read.get(input.entry_id) as Movement | undefined;
    if (!entry || entry.allowed !== 1 || entry.direction !== 'entry' || !entry.person_id)
      throw new ApiError(404, 'No se encontró una entrada permitida para corregir.');
    const nextMovement = sql.prepare(`SELECT * FROM events WHERE person_id=? AND zone_id=? AND allowed=1 AND id>?
      ORDER BY id LIMIT 1`);
    const next = nextMovement.get(entry.person_id, entry.zone_id, entry.id) as Movement | undefined;
    const exit = next?.direction === 'exit' ? next : null;
    if (!exit && next)
      throw new ApiError(
        400,
        'Solo se puede corregir una visita abierta si es el último movimiento de la persona en esta zona.',
      );
    if (exit && input.exit_at === null) throw new ApiError(400, 'No se puede eliminar una salida ya registrada.');
    const previous = sql
      .prepare(
        `SELECT occurred_at FROM events WHERE person_id=? AND zone_id=? AND allowed=1 AND id<?
      ORDER BY id DESC LIMIT 1`,
      )
      .get(entry.person_id, entry.zone_id, entry.id);
    const following = exit
      ? (nextMovement.get(entry.person_id, entry.zone_id, exit.id) as Movement | undefined)
      : undefined;
    if (
      (previous && input.entry_at < Number(previous.occurred_at)) ||
      (following && input.exit_at !== null && input.exit_at > following.occurred_at)
    )
      throw new ApiError(
        400,
        'Las horas deben quedar entre los movimientos anterior y siguiente de esta persona y zona.',
      );
    const settings = sql.prepare('SELECT timezone FROM settings WHERE id=1').get();
    if (!settings) throw new ApiError(400, 'No se encontró la zona horaria de la instalación.');
    const date = (at: number) => localParts(new Date(at), String(settings.timezone)).date;
    sql
      .prepare('UPDATE events SET occurred_at=?,local_date=? WHERE id=?')
      .run(input.entry_at, date(input.entry_at), entry.id);
    let exitId = exit?.id;
    if (input.exit_at !== null) {
      if (exit) {
        sql
          .prepare("UPDATE events SET occurred_at=?,local_date=?,reason='MANUAL_CORRECTION',detail=? WHERE id=?")
          .run(input.exit_at, date(input.exit_at), input.reason, exit.id);
      } else {
        const requestKey = 'correction_' + randomUUID();
        const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        exitId = Number(
          sql
            .prepare(
              `INSERT INTO events(request_key,payload_hash,person_id,person_name,zone_id,zone_name,
          direction,method,allowed,reason,detail,actor,occurred_at,local_date)
          VALUES(?,?,?,?,?,?,'exit','manual',1,'MANUAL_CORRECTION',?,?,?,?)`,
            )
            .run(
              requestKey,
              payloadHash,
              entry.person_id,
              entry.person_name,
              entry.zone_id,
              entry.zone_name,
              input.reason,
              String(member.email),
              input.exit_at,
              date(input.exit_at),
            ).lastInsertRowid,
        );
      }
    }
    // The existing audit table has no detail column; entity_id retains the full correction record as JSON.
    const audit = {
      entry_id: entry.id,
      actor: member,
      reason: input.reason,
      before: { entry, exit },
      after: { entry: read.get(entry.id), exit: exitId === undefined ? null : read.get(exitId) },
    };
    sql
      .prepare('INSERT INTO audit(actor,action,entity_id,occurred_at) VALUES(?,?,?,?)')
      .run(String(member.email), 'gym_session.corrected', JSON.stringify(audit), now);
    sql.exec('COMMIT');
    return { ok: true };
  } catch (error) {
    sql.exec('ROLLBACK');
    throw error;
  }
}
