import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function matchesApplication(candidate, appRoot, uid, ownPid) {
  if (candidate.pid === ownPid || candidate.uid !== uid || candidate.cwd !== appRoot) return false;
  const args = candidate.command.split('\0').filter(Boolean);
  const title = (args[0] || '').trim();
  return title === 'lsnode:' + appRoot || title === 'lsnode:' + appRoot + '/'
    || args.some(arg => /^\/(?:usr\/local\/lsws|opt\/lsws)\/fcgi-bin\/lsnode\.js$/.test(arg));
}

// Reinicia solo lsnode de esta aplicación y esta cuenta; nunca otros procesos Node.
export async function restartApplication(directory) {
  if (process.platform !== 'linux' || !process.getuid || !process.getuid())
    throw Error('El reinicio requiere la cuenta Linux sin privilegios de la aplicación.');
  const appRoot = realpathSync(directory), uid = process.getuid();
  if (!/^\/home\/[^/]+\/.+/.test(appRoot) || !existsSync(join(appRoot, 'app.js')))
    throw Error('Raíz de aplicación inválida.');
  const targets = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const proc = '/proc/' + entry;
      const candidate = { pid: Number(entry), uid: statSync(proc).uid,
        cwd: realpathSync(proc + '/cwd'), command: readFileSync(proc + '/cmdline', 'utf8') };
      if (matchesApplication(candidate, appRoot, uid, process.pid)) targets.push(candidate.pid);
    } catch { /* Un proceso puede terminar mientras se recorre /proc. */ }
  }
  const selected = targets.length;
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 50 && targets.length; attempt++) {
    for (let i = targets.length - 1; i >= 0; i--) {
      try { process.kill(targets[i], 0); }
      catch (error) { if (error.code === 'ESRCH') targets.splice(i, 1); else throw error; }
    }
    if (targets.length) await delay(200);
  }
  if (targets.length) throw Error('La aplicación todavía está cerrando peticiones. Verifica su reinicio en cPanel.');
  console.log(`Reinicio dirigido de LiteSpeed: ${selected} procesos de esta aplicación cerrados; Passenger conserva tmp/restart.txt.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  restartApplication(process.argv[2] || process.cwd()).catch(error => { console.error(error.message); process.exitCode = 1; });
