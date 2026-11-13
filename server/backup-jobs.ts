import { Worker } from 'node:worker_threads';
import { ApiError } from '../lib/service.ts';

/** Hashing, SQLite verification and archive extraction must not block reception/cashier requests. */
export function backupJob<T>(action: string, args: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
      workerData: { action, args }, resourceLimits: { maxOldGenerationSizeMb: 96 },
      // V8, Passenger and node --test flags accepted by the parent are not valid worker flags.
      execArgv: [],
    });
    let result: { error?: string; status?: number; value: T } | undefined;
    worker.once('message', message => { result = message; });
    worker.once('error', reject);
    // SQLite statements may keep file handles alive until worker teardown, especially on Windows.
    worker.once('exit', code => {
      if (code !== 0 || !result) reject(new Error('El proceso de respaldo terminó sin confirmar el resultado (' + code + ').'));
      else if (result.error) reject(new ApiError(result.status || 500, result.error));
      else resolve(result.value);
    });
  });
}
