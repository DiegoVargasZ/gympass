import { useEffect, useState } from 'react';
import { Cloud, HardDrive, WifiOff } from 'lucide-react';
import { api } from './api';

type Sync = { linked: boolean; online?: boolean; pending?: number; error?: string; conflict?: string; revoked?: boolean };
export default function ConnectionStatus({ platform = false, replica = false }: { platform?: boolean; replica?: boolean }) {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const next = await api<Sync | { ok: boolean }>(replica ? 'cloud-sync/status' : 'health', 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) {
          setReachable(true);
          if ('linked' in next) setSync(next);
        }
      } catch {
        if (!controller.signal.aborted) setReachable(false);
      } finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [platform, replica]);
  const problem = reachable === false || sync?.revoked || !!sync?.conflict || !!sync?.error;
  const label = reachable === false
    ? 'Sin conexión al servidor'
    : replica ? sync?.online && !problem ? 'Servidor conectado · copia local' : 'Servidor local · copia del gimnasio'
    : platform ? 'Servidor central'
    : 'Servidor local · computadora';
  const Icon = reachable === false ? WifiOff : platform ? Cloud : HardDrive;
  return (
    <span className={'connection-status' + (problem ? ' connection-warning' : '')} role="status" title={sync?.conflict || sync?.error || label}>
      <Icon size={16} aria-hidden="true" />
      <span>{reachable === null ? 'Comprobando conexión…' : label}{sync?.revoked ? ' · acceso revocado' : sync?.pending ? ` · ${sync.pending} pendientes` : ''}</span>
    </span>
  );
}
