import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, ApiError, type Actor } from '../lib/service.ts';
import type { SqliteDatabase } from './database.ts';
const derive = promisify(scrypt);
export async function passwordHash(password: string) {
  if (password.length < 6 || password.length > 200)
    throw new ApiError(400, 'La contraseña debe tener entre 6 y 200 caracteres.');
  const salt = randomBytes(16).toString('hex');
  const result = (await derive(password, salt, 64)) as Buffer;
  return salt + ':' + result.toString('hex');
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, value] = stored.split(':');
  if (!salt || !value) return false;
  const candidate = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
export async function session(db: SqliteDatabase, cookie: string | undefined): Promise<Actor | null> {
  const token = cookie
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('gympass_session='))
    ?.slice('gympass_session='.length);
  if (!token) return null;
  const m = await db
    .prepare(
      'SELECT m.* FROM sessions s JOIN members m ON m.user_id=s.user_id WHERE s.hash=? AND s.expires>? AND m.active=1',
    )
    .bind(await hash(token), Date.now())
    .first<Record<string, any>>();
  return m ? { id: m.user_id, email: m.email, name: m.name, role: m.role } : null;
}
export const sessionSeconds = (remember = false) => (remember ? 30 * 86400 : 12 * 3600);
export async function createSession(db: SqliteDatabase, userId: string, remember = false, mobile = false) {
  const token = (mobile ? 'm_' : '') + randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()).run();
  await db
    .prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)')
    .bind(await hash(token), userId, Date.now() + sessionSeconds(remember) * 1000)
    .run();
  return token;
}
export function cookie(token: string, clear = false, secure = false, remember = false) {
  return `gympass_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : sessionSeconds(remember)}${secure || process.env.SECURE_COOKIES === '1' ? '; Secure' : ''}`;
}
