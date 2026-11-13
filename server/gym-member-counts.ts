import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeBackupDirectory } from './backups.ts';
import { ApiError } from '../lib/service.ts';

export type GymMemberCounts = Record<string, number | null>;

/** Aggregate only: never create/migrate a gym database or load its member records. */
export function readGymMemberCounts(root: string, ids: string[]): GymMemberCounts {
  return Object.fromEntries(ids.map(id => {
    let raw: DatabaseSync | undefined;
    try {
      if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)) throw Error('Gimnasio inválido.');
      const directory = safeBackupDirectory(join(root, 'tenants', id));
      if (!existsSync(directory)) return [id, null];
      let file = join(directory, 'gympass.sqlite');
      if (!existsSync(file)) {
        const candidates = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
        if (candidates.length !== 1) return [id, null];
        file = join(directory, candidates[0]);
      }
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return [id, null];
      raw = new DatabaseSync(file, { readOnly: true });
      raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; PRAGMA cache_size=-512;');
      if (raw.prepare('SELECT owner FROM settings WHERE id=1').get()?.owner !== id) return [id, null];
      const count = Number(raw.prepare("SELECT COUNT(*) n FROM people WHERE kind='member' AND deleted_at IS NULL").get()!.n);
      return [id, count];
    } catch {
      // An unavailable/corrupt gym must not hide the remaining counts or appear to have zero members.
      return [id, null];
    } finally { raw?.close(); }
  }));
}

/** Share concurrent refreshes and allow at most one counting worker per platform process. */
export function createGymMemberCounter(root: string) {
  let pending: { key: string; result: Promise<GymMemberCounts> } | undefined;
  return async (gyms: { id: string }[]): Promise<GymMemberCounts> => {
    const ids = gyms.map(gym => gym.id).sort();
    if (!ids.length) return {};
    const key = ids.join(',');
    while (pending) {
      if (pending.key === key) return pending.result;
      await pending.result.catch(() => {});
    }
    const result = new Promise<GymMemberCounts>((resolve, reject) => {
      const worker = new Worker(new URL('./gym-member-counts-worker.mjs', import.meta.url), {
        workerData: { root, ids }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      const timer = setTimeout(() => { void worker.terminate(); }, 15000);
      let counts: GymMemberCounts | undefined;
      worker.once('message', result => { counts = result; });
      worker.once('error', reject);
      worker.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !counts) reject(new ApiError(503, 'No se pudieron consultar los totales de socios. Actualiza la lista para reintentar.'));
        else resolve(counts);
      });
    });
    pending = { key, result };
    try { return await result; } finally { if (pending?.result === result) pending = undefined; }
  };
}
