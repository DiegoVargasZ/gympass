import type { Database } from '../lib/database.ts';
import { Service } from '../lib/service.ts';

export function sessionMaintenance(db: Database, now = () => new Date(), exclusive?: (operation: () => Promise<{ closed: number }>) => Promise<{ closed: number }>) {
  const service = new Service(db, { id: 'system', email: 'system', name: 'Sistema', role: 'admin' });
  let running: Promise<{ closed: number }> | null = null;
  function check() {
    if (running) return running;
    const operation = async () => {
      const settings = await service.one('SELECT timezone,auto_close_hours,closing_time FROM settings WHERE id=1');
      if (!settings) return { closed: 0 };
      const at = now();
      const result = await service.closeStaleSessions(at);
      const visits = await service.closeExpiredVisits(at);
      if (visits.closed)
        console.log(`Visitas cerradas: ${visits.closed} ${visits.closed === 1 ? 'visita' : 'visitas'}.`);
      if (result.closed)
        console.log(`Cierre automático: ${result.closed} ${result.closed === 1 ? 'sesión' : 'sesiones'}.`);
      return result;
    };
    running = (exclusive ? exclusive(operation) : operation()).finally(() => {
      running = null;
    });
    return running;
  }
  const timer = setInterval(() => {
    void check().catch((error) => console.error('Cierre automático:', error));
  }, 60000);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}
