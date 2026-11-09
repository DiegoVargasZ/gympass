import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Bootstrap } from '../lib/domain';
import Kiosk from './Kiosk';
import { Skeleton } from './ui';
import { setPlatformContext } from './platform-context';
import { accessQueueIdentity, setAccessQueueIdentity, startOfflineQueue } from './offline';

export function StartPlatformKiosk() {
  const [error, setError] = useState('');
  const start = useCallback(async () => {
    try {
      await api('kiosk/start', 'POST');
      location.reload();
    } catch (cause) { setError((cause as Error).message); }
  }, []);
  useEffect(() => { void start(); }, [start]);
  return <main className="loading-screen">{error ? <><p role="alert">{error}</p><button className="btn primary" onClick={() => void start()}>Reintentar</button><a href="#access">Volver a Recepción</a></> : <Skeleton rows={4} label="Protegiendo sesión del lector" />}</main>;
}

export default function PlatformKiosk({ gymId }: { gymId: string }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setPlatformContext({ gymId });
    const next = await api<Bootstrap>('kiosk/bootstrap');
    setData(next);
    setError('');
  }, [gymId]);
  useEffect(() => {
    void reload().catch(cause => setError((cause as Error).message));
    const timer = setInterval(() => void reload().catch(cause => setError((cause as Error).message)), 30000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    if (!data) return;
    void setAccessQueueIdentity(accessQueueIdentity(data));
    const stop = startOfflineQueue();
    return () => { stop(); void setAccessQueueIdentity(null); };
  }, [data?.installation_id, data?.user.id]);
  if (error) return <main className="loading-screen"><p role="alert">{error}</p><button className="btn primary" onClick={() => void reload().catch(cause => setError((cause as Error).message))}>Reintentar</button><button className="btn secondary" onClick={async () => { await api('platform/logout', 'POST'); location.assign(location.pathname); }}>Iniciar sesión</button></main>;
  if (!data) return <Skeleton rows={4} label="Abriendo acceso automático" />;
  return <Kiosk data={data} reload={reload} restricted />;
}
