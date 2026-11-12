import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Trash2 } from 'lucide-react';
import { api } from './api';
import { Empty, Field, Form, Skeleton } from './ui';

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'danger';
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  author: string;
  gym_ids: string[];
};
type Target = { id: string; name: string };

const severities = {
  info: 'Informativo',
  warning: 'Importante',
  danger: 'Urgente',
};

/** Vigente, retirado o vencido: el superadministrador necesita saberlo sin abrir el aviso. */
function state(announcement: Announcement, now: number) {
  if (announcement.revoked_at) return 'Retirado';
  if (announcement.expires_at && announcement.expires_at <= now) return 'Vencido';
  return 'Visible';
}

export default function PlatformAnnouncements({ gyms }: { gyms: Target[] }) {
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  const [everyone, setEveryone] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api<{ announcements: Announcement[] }>('platform/announcements');
      setAnnouncements(result.announcements);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
      setAnnouncements([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  return (
    <div className="platform-announcements">
      <Form
        label="Enviar aviso"
        onSubmit={async (form) => {
          if (!everyone && !chosen.length) throw Error('Elige al menos un gimnasio o envía el aviso a todos.');
          const input = Object.fromEntries(form);
          await api('platform/announcements', 'POST', {
            title: input.title,
            body: input.body,
            severity: input.severity,
            days: input.days,
            gym_ids: everyone ? [] : chosen,
          });
          setNotice(
            everyone
              ? 'Aviso enviado a todos los gimnasios. Aparecerá en su campana de alertas.'
              : `Aviso enviado a ${chosen.length} gimnasio${chosen.length === 1 ? '' : 's'}.`,
          );
          setChosen([]);
          setEveryone(true);
          await load();
        }}
      >
        <Field label="Título" hint="Lo primero que leerán. Ejemplo: Mantenimiento el domingo.">
          <input name="title" required minLength={2} maxLength={120} />
        </Field>
        <Field label="Mensaje">
          <textarea name="body" required minLength={2} maxLength={2000} rows={4} />
        </Field>
        <Field label="Importancia">
          <select name="severity" defaultValue="info">
            <option value="info">Informativo</option>
            <option value="warning">Importante</option>
            <option value="danger">Urgente</option>
          </select>
        </Field>
        <Field label="Días visible" hint="El aviso desaparece solo al cumplirse el plazo. Entre 1 y 90 días.">
          <input name="days" type="number" min={1} max={90} defaultValue={7} required />
        </Field>
        <Field label="Destinatarios">
          <select
            value={everyone ? 'all' : 'selected'}
            onChange={(event) => setEveryone(event.target.value === 'all')}
          >
            <option value="all">Todos los gimnasios</option>
            <option value="selected">Gimnasios elegidos</option>
          </select>
        </Field>
        {!everyone && (
          <div className="platform-announcement-targets">
            {!gyms.length ? (
              <p className="helper">Todavía no hay gimnasios a los que enviar el aviso.</p>
            ) : (
              gyms.map((gym) => (
                <label key={gym.id} className="check-inline">
                  <input
                    type="checkbox"
                    checked={chosen.includes(gym.id)}
                    onChange={(event) =>
                      setChosen((current) =>
                        event.target.checked ? [...current, gym.id] : current.filter((id) => id !== gym.id),
                      )
                    }
                  />{' '}
                  {gym.name}
                </label>
              ))
            )}
          </div>
        )}
        <p className="helper">
          El aviso llega al centro de alertas de cada gimnasio. Enviarlo a todos incluye los gimnasios que se creen
          mientras siga vigente.
        </p>
      </Form>
      {notice && (
        <p role="status" className="platform-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <h3>
        <Megaphone size={18} aria-hidden="true" /> Avisos enviados
      </h3>
      {!announcements ? (
        <Skeleton />
      ) : !announcements.length ? (
        <Empty title="Sin avisos" text="Los avisos que envíes quedarán aquí, con la opción de retirarlos." />
      ) : (
        <ul className="platform-announcement-list">
          {announcements.map((announcement) => (
            <li key={announcement.id}>
              <div>
                <strong>{announcement.title}</strong>
                <p>{announcement.body}</p>
                <small>
                  {severities[announcement.severity]} · {state(announcement, now)} ·{' '}
                  {announcement.gym_ids.length
                    ? announcement.gym_ids.length === 1
                      ? gyms.find((gym) => gym.id === announcement.gym_ids[0])?.name || '1 gimnasio'
                      : announcement.gym_ids.length + ' gimnasios'
                    : 'Todos los gimnasios'}{' '}
                  · {announcement.author} · {new Date(announcement.created_at).toLocaleString()}
                </small>
              </div>
              {!announcement.revoked_at && (
                <button
                  className="btn secondary danger"
                  disabled={busy === announcement.id}
                  onClick={async () => {
                    if (!confirm(`¿Retirar «${announcement.title}»? Dejará de verse en los gimnasios.`)) return;
                    setBusy(announcement.id);
                    setError('');
                    try {
                      await api('platform/announcements/' + encodeURIComponent(announcement.id), 'DELETE');
                      setNotice('Aviso retirado.');
                      await load();
                    } catch (reason) {
                      setError((reason as Error).message);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" /> {busy === announcement.id ? 'Retirando…' : 'Retirar'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
