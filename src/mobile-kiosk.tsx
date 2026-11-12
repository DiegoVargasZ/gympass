import { useEffect, useState } from 'react';
import { api } from './api';
import type { Bootstrap } from '../lib/domain';
import Kiosk from './Kiosk';

export function StartPlatformKiosk() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const reload = async () => { setData(await api<Bootstrap>('bootstrap?compact=1')); setError(''); };
  useEffect(() => { void reload().catch(cause => setError(cause.message)); const timer = setInterval(() => void reload().catch(() => {}), 30000); return () => clearInterval(timer); }, []);
  if (error) return <main><p role="alert">{error}</p><a href="#access">Volver a Recepción</a></main>;
  return data ? <Kiosk data={data} reload={reload} /> : <p>Abriendo acceso automático…</p>;
}
