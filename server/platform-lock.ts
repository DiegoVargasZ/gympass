import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquirePlatformLock(root: string) {
  const path = join(root, '.platform-running.json');
  const id = crypto.randomUUID();
  const write = () => writeFileSync(path, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
  try {
    write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let previous: { pid: number };
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw Error('El marcador de plataforma es inválido. Comprueba el servidor antes de retirarlo.');
    }
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw Error('Marcador de plataforma inválido.');
    let live = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false;
    }
    if (live) throw Error('Esta carpeta ya está siendo utilizada por otro servidor GymPASS.');
    unlinkSync(path);
    write();
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).id === id) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
