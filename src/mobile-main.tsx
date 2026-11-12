import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installMobileTransport } from './mobile-transport';
import { setPlatformContext } from './platform-context';
import { applyPreferences } from './preferences';
import { api } from './api';
import './styles/index.css';

installMobileTransport();
applyPreferences();

function MobileStatus() {
  const [status, setStatus] = useState<{ online: boolean; pending: number; server: string; conflict?: string; error?: string; revoked?: boolean }>();
  useEffect(() => {
    let active = true;
    const update = () => void api('cloud-sync/status').then(value => { if (active) setStatus(value); }).catch(() => {});
    update();
    const timer = setInterval(update, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const element = document.getElementById('mobile-sync-status');
    if (!element) return;
    const resize = new ResizeObserver(() => document.documentElement.style.setProperty('--gympass-sync-height', element.getBoundingClientRect().height + 'px'));
    resize.observe(element); return () => resize.disconnect();
  }, []);
  return <div id="mobile-sync-status" role="status" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 25, padding: '8px 12px', background: 'var(--surface)', borderTop: '1px solid var(--border-strong)', color: 'var(--ink)', fontSize: 12 }}>
    {status ? status.revoked ? 'Acceso revocado. Los pendientes se conservan.' : status.conflict ? 'Cambios guardados. Hay un conflicto para revisar.' : `${status.online ? 'Conectado' : 'Sin Internet'} · ${status.pending ? status.pending + ' cambios guardados en este teléfono' : 'Sin cambios pendientes'} · Sincronización automática` : 'Abriendo la copia del teléfono…'}
    {status?.server && <a href={status.server} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 4 }}>Cuenta y respaldos del servidor</a>}
  </div>;
}

async function start() {
  const context = await api<{ gym_id: string }>('mobile/context');
  setPlatformContext({ gymId: context.gym_id });
  const style = document.createElement('style');
  style.textContent = '.app-shell{padding-bottom:var(--gympass-sync-height,60px)}.app-shell .mobile-navigation{bottom:var(--gympass-sync-height,60px)}';
  document.head.append(style);
  createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p>Abriendo GymPASS…</p>}><App onLogout={() => location.reload()} /><MobileStatus /></React.Suspense></React.StrictMode>);
}
void start().catch(error => {
  const root = document.getElementById('root')!;
  const message = document.createElement('p');
  message.textContent = 'No se pudo abrir la copia local: ' + error.message;
  const login = document.createElement('button');
  login.className = 'btn primary';
  login.textContent = 'Volver a iniciar sesión';
  login.onclick = async () => {
    login.disabled = true;
    try { await api('auth/logout', 'POST'); login.textContent = 'Abriendo el acceso…'; }
    catch (cause) { message.textContent = (cause as Error).message; login.disabled = false; }
  };
  root.replaceChildren(message, login);
});
