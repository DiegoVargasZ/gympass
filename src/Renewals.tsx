import { Fragment, useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCheck,
  Copy,
  MessageCircle,
  Pencil,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from './api';
import { copyText } from './browser';
import { Avatar, Badge, Empty, Skeleton, type Notify } from './ui';
import { PersonForm } from './People';
import type { Bootstrap, Person } from '../lib/domain';

type Expiration = {
  id: string;
  name: string;
  document: string;
  phone: string;
  expires: string;
  photo_path: string | null;
  notified_at: number | null;
  days: number;
  message: string;
};
type Report = {
  rows: Expiration[];
  total: number;
  pageSize: number;
  summary: { soon: number; today: number; overdue: number; pending: number; withoutPhone: number };
};
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat('es-BO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const dueLabel = (days: number) =>
  days < 0
    ? `Venció hace ${Math.abs(days)} d`
    : days === 0
      ? 'Vence hoy'
      : days === 1
        ? 'Vence mañana'
        : `Vence en ${days} días`;

function useExpirations(query: string, enabled = true) {
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(enabled),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const refresh = (event?: Event) => {
      const topics = (event as CustomEvent | undefined)?.detail?.topics as string[] | undefined;
      if (!topics || topics.some((topic) => ['people', 'pos', 'settings', 'time'].includes(topic)))
        setRevision((value) => value + 1);
    };
    window.addEventListener('data-reloaded', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('data-reloaded', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      api<Report>('expirations?' + query, 'GET', undefined, controller.signal)
        .then((value) => {
          setReport(value);
          setError('');
        })
        .catch((reason) => {
          if (reason.name !== 'AbortError') setError(reason.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, revision]);
  return { report, busy, error, refresh: () => setRevision((value) => value + 1) };
}
export default function Renewals({
  data,
  reload,
  notify,
}: {
  data: Bootstrap;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const [view, setView] = useState('soon'),
    [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [edit, setEdit] = useState<Person | null>(null),
    [working, setWorking] = useState('');
  const { report, busy, error, refresh } = useExpirations(
    new URLSearchParams({ view, q, page: String(page) }).toString(),
  );
  async function editPerson(id: string) {
    setWorking(id);
    try {
      setEdit(await api<Person>('people/' + id));
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  async function mark(row: Expiration) {
    setWorking(row.id);
    try {
      await api('expirations/' + row.id, 'POST', { expires: row.expires, notified: !row.notified_at });
      refresh();
      window.dispatchEvent(new Event('data-reloaded'));
      notify(row.notified_at ? 'Cuenta marcada como pendiente' : 'Aviso registrado');
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Planes por vencer</h1>
          <p>Socios cuyo plan está por terminar o ya terminó. Avísales por WhatsApp y renueva su plan.</p>
        </div>
        <Badge tone="blue">
          <CalendarClock size={15} /> Se muestran desde 3 días antes
        </Badge>
      </div>
      <dl className="renewal-metrics" aria-label="Resumen de vencimientos">
        {[
          ['Por avisar', report?.summary.pending, 'Aún no se les avisó'],
          ['Vencen hoy', report?.summary.today, 'Su plan termina hoy'],
          ['Ya vencidas', report?.summary.overdue, 'Esperan renovar su plan'],
          ['Sin WhatsApp', report?.summary.withoutPhone, 'No tienen teléfono registrado'],
        ].map(([label, value, note]) => (
          <div className="renewal-metric" key={String(label)}>
            <dt>{label}</dt>
            <dd>{value ?? '…'}</dd>
            <p>{note}</p>
          </div>
        ))}
      </dl>
      <section className="panel">
        <div className="toolbar">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="Buscar vencimientos"
              placeholder="Buscar por nombre o documento"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            aria-label="Filtrar vencimientos"
            value={view}
            onChange={(event) => {
              setView(event.target.value);
              setPage(1);
            }}
          >
            <option value="soon">Vencen en los próximos 3 días</option>
            <option value="overdue">Ya vencieron</option>
            <option value="all">Todos</option>
          </select>
        </div>
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : busy ? (
          <Skeleton rows={4} />
        ) : !report?.rows.length ? (
          <Empty
            title="Nadie por vencer"
            text="Cuando el plan de un socio esté por terminar, aparecerá aquí para que le avises."
          />
        ) : (
          <div className="table-scroll renewals-table">
            <table>
              <thead>
                <tr>
                  <th>Persona</th>
                  <th>Vence</th>
                  <th>WhatsApp</th>
                  <th>¿Ya se le avisó?</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, index) => (
                  <Fragment key={row.id}>
                    {(index === 0 || Math.sign(row.days) !== Math.sign(report.rows[index - 1].days)) && (
                      <tr className="renewal-group">
                        <th colSpan={5}>
                          {row.days < 0 ? 'Vencidas' : row.days === 0 ? 'Vencen hoy' : 'Próximos vencimientos'}
                        </th>
                      </tr>
                    )}
                    <tr>
                      <td>
                        <div className="person-cell">
                          <Avatar name={row.name} personId={row.id} photoPath={row.photo_path} />
                          <div>
                            <strong>{row.name}</strong>
                            <small>{row.document}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong>{dateLabel(row.expires)}</strong>
                        <small>
                          <Badge tone={row.days <= 0 ? 'red' : row.days <= 3 ? 'amber' : 'gray'}>
                            {dueLabel(row.days)}
                          </Badge>
                        </small>
                      </td>
                      <td>
                        {row.phone ? (
                          <span className="mono">+{row.phone}</span>
                        ) : (
                          <button
                            className="text-btn"
                            disabled={working === row.id}
                            onClick={() => void editPerson(row.id)}
                          >
                            Añadir teléfono
                          </button>
                        )}
                      </td>
                      <td>
                        <Badge tone={row.notified_at ? 'green' : 'amber'}>
                          {row.notified_at ? 'Avisado' : 'Por avisar'}
                        </Badge>
                      </td>
                      <td>
                        <div className="row-actions">
                          {row.phone && (
                            <a
                              className="btn small whatsapp"
                              href={'https://wa.me/' + row.phone + '?text=' + encodeURIComponent(row.message)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <MessageCircle size={15} /> WhatsApp
                            </a>
                          )}
                          <button
                            className="icon-btn"
                            title="Copiar mensaje"
                            aria-label={'Copiar mensaje para ' + row.name}
                            onClick={async () => {
                              try {
                                await copyText(row.message);
                                notify('Mensaje copiado');
                              } catch {
                                notify('No se pudo copiar el mensaje.', true);
                              }
                            }}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            className="btn small secondary"
                            disabled={working === row.id}
                            onClick={() => void mark(row)}
                          >
                            <CheckCheck size={15} />
                            {row.notified_at ? 'Desmarcar aviso' : 'Ya avisé'}
                          </button>
                          <button
                            className="btn small secondary"
                            disabled={working === row.id}
                            aria-label={'Renovar plan de ' + row.name}
                            onClick={() => void editPerson(row.id)}
                          >
                            <Pencil size={15} /> Renovar
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>{report?.total || 0} cuentas</span>
          <div>
            <button
              className="icon-btn"
              aria-label="Vencimientos anteriores"
              disabled={busy || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              Página {page} de {Math.max(1, Math.ceil((report?.total || 0) / 50))}
            </span>
            <button
              className="icon-btn"
              aria-label="Vencimientos siguientes"
              disabled={busy || page * 50 >= (report?.total || 0)}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>
      <p className="helper">
        WhatsApp abre el mensaje ya escrito; tú decides cuándo enviarlo. Después pulsa «Ya avisé» para llevar el
        control. Al renovar la fecha, el aviso empieza de nuevo.
      </p>
      {edit && (
        <PersonForm
          data={data}
          person={edit}
          onClose={() => setEdit(null)}
          onDone={async () => {
            await reload();
            refresh();
          }}
        />
      )}
    </>
  );
}
