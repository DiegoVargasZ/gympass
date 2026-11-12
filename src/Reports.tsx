import { useEffect, useState } from 'react';
import { Download, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, download } from './api';
import type { AccessEvent, Bootstrap } from '../lib/domain';
import { EventTable, Field, Skeleton, type Notify } from './ui';
import SavedReports from './SavedReports';

export default function Reports({ data, notify }: { data: Bootstrap; notify: Notify }) {
  const defaults = { from: data.today, to: data.today, zone: '', result: '', q: '' };
  const initial = { ...defaults, ...Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])) };
  const [filters, setFilters] = useState(initial),
    [query, setQuery] = useState(new URLSearchParams(initial).toString()),
    [page, setPage] = useState(1),
    [events, setEvents] = useState<AccessEvent[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event?: Event) => {
      const topics = (event as CustomEvent | undefined)?.detail?.topics as string[] | undefined;
      if (!topics || topics.some((topic) => ['access', 'people', 'settings', 'time'].includes(topic)))
        setRevision((value) => value + 1);
    };
    window.addEventListener('data-reloaded', refresh);
    return () => window.removeEventListener('data-reloaded', refresh);
  }, []);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    api<{ rows: AccessEvent[]; total: number }>('events?' + query + '&page=' + page)
      .then((result) => {
        if (!live) return;
        setEvents(result.rows);
        setTotal(result.total);
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [query, page, revision]);
  const set = (key: keyof typeof filters, value: string) => setFilters((old) => ({ ...old, [key]: value }));
  const personId = new URLSearchParams(query).get('person');
  const [personName, setPersonName] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setPersonName('');
    if (personId)
      void api<{ name: string }>('people/' + encodeURIComponent(personId) + '/summary', 'GET', undefined, abort.signal)
        .then((person) => setPersonName(person.name))
        .catch(() => {});
    return () => abort.abort();
  }, [personId]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Historial de accesos</h1>
          <p>Explora las entradas, salidas e intentos de acceso.</p>
        </div>
        <button
          className="btn secondary"
          disabled={busy || !!error}
          onClick={async () => {
            try {
              await download('events/export?' + query, 'accesos.csv');
              notify('Reporte exportado');
            } catch (reason) {
              notify((reason as Error).message, true);
            }
          }}
        >
          <Download size={17} /> Exportar CSV
        </button>
      </div>
      <SavedReports
        kind="events"
        query={query}
        notify={notify}
        onApply={(value) => {
          const allowed = ['from', 'to', 'zone', 'result', 'q', 'person'];
          const next = {
            ...defaults,
            ...Object.fromEntries([...new URLSearchParams(value)].filter(([key]) => allowed.includes(key))),
          };
          if (!/^\d{4}-\d{2}-\d{2}$/.test(next.from) || !/^\d{4}-\d{2}-\d{2}$/.test(next.to) || next.from > next.to)
            throw Error('La consulta guardada contiene un período inválido.');
          setFilters(next);
          setQuery(new URLSearchParams(next).toString());
          setPage(1);
        }}
      />
      <section className="panel">
        <form
          className="report-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(new URLSearchParams(filters).toString());
          }}
        >
          <Field label="Desde">
            <input
              type="date"
              required
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) => set('from', event.target.value)}
            />
          </Field>
          <Field label="Hasta">
            <input
              type="date"
              required
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) => set('to', event.target.value)}
            />
          </Field>
          <Field label="Resultado">
            <select value={filters.result} onChange={(event) => set('result', event.target.value)}>
              <option value="">Todos</option>
              <option value="allowed">Permitidos</option>
              <option value="denied">Denegados</option>
            </select>
          </Field>
          <Field label="Buscar">
            <input placeholder="Persona, documento o zona" value={filters.q} onChange={(event) => set('q', event.target.value)} />
          </Field>
          <button className="btn primary">
            <Search size={16} /> Consultar
          </button>
        </form>
        <div className="report-context" role="status">
          {personId && (
            <p>
              Persona: <strong>{personName || 'Persona seleccionada'}</strong>
            </p>
          )}
          <p>
            Período consultado:{' '}
            <strong>
              {new URLSearchParams(query).get('from')} a {new URLSearchParams(query).get('to')}
            </strong>{' '}
            · {total} movimientos
          </p>
          {(new URLSearchParams(query).get('q') || new URLSearchParams(query).get('result')) && (
            <p>
              Filtros:{' '}
              {[
                new URLSearchParams(query).get('q'),
                new URLSearchParams(query).get('result') === 'denied'
                  ? 'Denegados'
                  : new URLSearchParams(query).get('result') === 'allowed'
                    ? 'Permitidos'
                    : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {new URLSearchParams(filters).toString() !== query && (
            <p className="pending-filters">
              Hay filtros sin aplicar. Pulsa Consultar; la exportación usa el período consultado.
            </p>
          )}
          <button
            type="button"
            className="btn secondary small"
            onClick={() => {
              setFilters(defaults);
              setQuery(new URLSearchParams(defaults).toString());
              setPage(1);
            }}
          >
            Limpiar filtros
          </button>
        </div>
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : busy ? (
          <Skeleton />
        ) : (
          <EventTable events={events} timezone={data.settings.timezone} />
        )}
        <div className="pagination">
          <span>{busy ? 'Consultando…' : `${total} registros`}</span>
          <div>
            <button
              className="icon-btn"
              aria-label="Página anterior"
              disabled={busy || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              Página {page} de {Math.max(1, Math.ceil(total / 50))}
            </span>
            <button
              className="icon-btn"
              aria-label="Página siguiente"
              disabled={busy || page * 50 >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>
      <p className="helper">
        El historial cuenta movimientos, incluidos reingresos y rechazos. Consulta la duración de cada visita en Visitas
        y tiempos. Los cierres automáticos son salidas estimadas. La exportación incluye hasta 10.000 movimientos.
      </p>
    </>
  );
}
