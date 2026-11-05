import { renameSync } from 'node:fs';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
// Windows scanners can briefly hold the destination without FILE_SHARE_DELETE.
// Retry the atomic rename; never unlink the previous valid state to make room.
export function replaceFileSync(
  source: string,
  destination: string,
  rename = renameSync,
  wait = (ms: number) => {
    Atomics.wait(waitCell, 0, 0, ms);
  },
) {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || ''))
        throw error;
      wait(20 * (attempt + 1));
    }
  }
}
