import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, CircleAlert, Info, Megaphone, MessageCircle, TriangleAlert } from 'lucide-react';
import { api } from './api';
import type { Alert } from '../lib/domain';
import { stamp } from './ui';

const icons = { info: Info, warning: TriangleAlert, danger: CircleAlert };

/**
 * Alerts are recomputed by the server from live state, so this panel never shows a condition
 * that has already cleared. Marking as read only hides the badge, never the alert itself.
 */
export default function Alerts({ timezone }: { timezone: string }) {
  const [open, setOpen] = useState(false),
    [alerts, setAlerts] = useState<Alert[]>([]),
    [unread, setUnread] = useState(0),
    [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);

  async function load() {
    try {
      const result = await api<{ alerts: Alert[]; unread: number }>('alerts');
      setAlerts(result.alerts);
      setUnread(result.unread);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('data-reloaded', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('data-reloaded', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function markRead(keys: string[]) {
    if (!keys.length) return;
    try {
      await api('alerts/read', 'POST', { keys });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <div className="alerts">
      <button
        ref={button}
        className="icon-btn alerts-trigger"
        aria-label={unread ? `Alertas: ${unread} sin leer` : 'Alertas'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={18} />
        {!!unread && <span className="alerts-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="alerts-panel" ref={panel} role="dialog" aria-label="Centro de alertas">
          <div className="alerts-head">
            <strong>Alertas</strong>
            {!!unread && (
              <button className="text-btn" onClick={() => markRead(alerts.filter((a) => !a.read).map((a) => a.key))}>
                <CheckCheck size={15} /> Marcar todas
              </button>
            )}
          </div>
          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : !alerts.length ? (
            <p className="alerts-empty">Todo en orden. No hay alertas activas.</p>
          ) : (
            <ul>
              {alerts.map((alert) => {
                // Un aviso de GymPASS no describe el estado del gimnasio, así que se distingue a simple vista.
                const Icon = alert.kind === 'announcement' ? Megaphone : icons[alert.severity];
                return (
                  <li
                    key={alert.key}
                    className={(alert.read ? 'read' : '') + (alert.kind === 'announcement' ? ' announcement' : '')}
                  >
                    <span className={'alert-icon ' + alert.severity}>
                      <Icon size={17} />
                    </span>
                    <div>
                      <strong>{alert.title}</strong>
                      <p>{alert.detail}</p>
                      <small>{stamp(alert.at, timezone, true)}</small>
                    </div>
                    <div className="alert-actions">
                      {alert.whatsapp && (
                        <a
                          className="btn small whatsapp"
                          href={`https://wa.me/${alert.whatsapp.phone}?text=${encodeURIComponent(alert.whatsapp.text)}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => void markRead([alert.key])}
                        >
                          <MessageCircle size={14} /> Avisar
                        </a>
                      )}
                      {alert.href && (
                        <a
                          className="text-btn"
                          href={alert.href}
                          onClick={() => {
                            setOpen(false);
                            void markRead([alert.key]);
                          }}
                        >
                          Ver
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
