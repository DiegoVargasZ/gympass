import { useEffect, useState } from 'react';
import { Download, Search } from 'lucide-react';
import type { Bootstrap, GymSession } from '../lib/domain';
import { api, download } from './api';
import { Badge, Field, PageHeader, RecordList, Skeleton, stamp, type Notify } from './ui';
import { useGymClock } from './GymPresence';
import { durationLabel } from '../lib/gym';
import {
  filterGymSessions,
  gymSummaryCsv,
  summarizeGymSessions,
  type GymMemberHours,
  type GymSessionState,
} from '../lib/gym-summary';
import './styles/gym-visits.css';

export default function GymVisits({ data, notify }: { data: Bootstrap; notify: Notify }) {
  const initial = new URLSearchParams(location.hash.split('?')[1]);
  const initialPerson = initial.get('person') || '';
  const [filters, setFilters] = useState({ from: data.today, to: data.today });
  const [query, setQuery] = useState(new URLSearchParams({ ...filters, person: initialPerson }).toString());
  // El perfil de un socio enlaza aquí con su documento ya escrito en el buscador.
  const [search, setSearch] = useState(() => (initial.get('q') || '').slice(0, 120));
  const [state, setState] = useState<GymSessionState>('all');
  const [view, setView] = useState<'visits' | 'hours'>('visits');
  const [rows, setRows] = useState<GymSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<GymSession | null>(null);
  const [Correction, setCorrection] = useState<typeof import('./SessionCorrection').default | null>(null);
  const now = useGymClock();
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError('');
    api<{ rows: GymSession[] }>('gym-sessions?' + query, 'GET', undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setRows(value.rows);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [query, data, revision]);
  const applied = new URLSearchParams(query);
  const filtered = filterGymSessions(rows, {
    from: applied.get('from') || data.today,
    to: applied.get('to') || data.today,
    person: applied.get('person') || '',
    q: search,
    state,
  });
  const summaries = summarizeGymSessions(filtered);
  const closed = filtered.filter((row) => row.exit_at !== null);
  const total = closed.reduce((sum, row) => sum + Math.max(0, row.exit_at! - row.entry_at), 0);
  const pending = filters.from !== applied.get('from') || filters.to !== applied.get('to');
  const exportQuery = new URLSearchParams(query);
  exportQuery.set('q', search);
  exportQuery.set('state', state);
  const status = (row: GymSession) => (
    <Badge tone={row.exit_at === null ? 'blue' : row.auto_closed ? 'amber' : 'green'}>
      {row.exit_at === null ? 'Dentro' : row.auto_closed ? 'Salida estimada' : 'Finalizada'}
    </Badge>
  );
  const exit = (row: GymSession) =>
    row.exit_at === null ? 'Pendiente de salida' : stamp(row.exit_at, data.settings.timezone, true);
  const hours = (ms: number | null) => (ms === null ? 'Sin visitas finalizadas' : durationLabel(0, ms, 0));
  const estimates = (row: GymMemberHours) =>
    row.estimated_visits ? (
      <small className="gym-hours-estimate">
        {hours(row.estimated_ms)} estimadas en {row.estimated_visits}{' '}
        {row.estimated_visits === 1 ? 'cierre automático' : 'cierres automáticos'}
      </small>
    ) : null;
  const correct = (row: GymSession) =>
    data.user?.role === 'admin' && (
      <button
        type="button"
        className="btn secondary"
        onClick={async () => {
          try {
            const { default: Editor } = await import('./SessionCorrection');
            setCorrection(() => Editor);
            setSelected(row);
          } catch (reason) {
            notify((reason as Error).message, true);
          }
        }}
      >
        Corregir
      </button>
    );
  return (
    <>
      <PageHeader
        title="Tiempo en el gimnasio"
        description="Cada ingreso tiene su propia entrada, salida y duración, incluso si vuelven el mismo día."
        primaryAction={
          <button
            className="btn secondary"
            disabled={busy || !!error || exporting}
            onClick={async () => {
              setExporting(true);
              try {
                if (view === 'hours') {
                  const csv = gymSummaryCsv(summaries, {
                    from: applied.get('from') || data.today,
                    to: applied.get('to') || data.today,
                    timezone: data.settings.timezone,
                  });
                  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
                  try {
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `horas-por-socio-${applied.get('from')}-${applied.get('to')}.csv`;
                    link.click();
                  } finally {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }
                  notify('Horas por socio exportadas');
                } else {
                  await download('gym-sessions/export?' + exportQuery, 'visitas-gimnasio.csv');
                  notify('Visitas exportadas');
                }
              } catch (reason) {
                notify((reason as Error).message, true);
              } finally {
                setExporting(false);
              }
            }}
          >
            <Download size={17} />
            {exporting ? 'Exportando…' : view === 'hours' ? 'Exportar horas por socio' : 'Exportar visitas filtradas'}
          </button>
        }
      />
      <section className="panel gym-visits-report">
        <div className="gym-visits-views" role="group" aria-label="Vista del reporte">
          <button type="button" aria-pressed={view === 'visits'} onClick={() => setView('visits')}>
            Visitas
          </button>
          <button type="button" aria-pressed={view === 'hours'} onClick={() => setView('hours')}>
            Horas por socio
          </button>
        </div>
        <form
          className="report-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(new URLSearchParams({ ...filters, person: applied.get('person') || '' }).toString());
            setRevision((v) => v + 1);
          }}
        >
          <Field label="Desde">
            <input
              type="date"
              required
              value={filters.from}
              max={filters.to}
              onChange={(e) => setFilters((v) => ({ ...v, from: e.target.value }))}
            />
          </Field>
          <Field label="Hasta">
            <input
              type="date"
              required
              value={filters.to}
              min={filters.from}
              onChange={(e) => setFilters((v) => ({ ...v, to: e.target.value }))}
            />
          </Field>
          <button className="btn primary">
            <Search size={17} />
            Consultar
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              const next = { from: data.today, to: data.today };
              setFilters(next);
              setQuery(new URLSearchParams({ ...next, person: applied.get('person') || '' }).toString());
              setRevision((v) => v + 1);
            }}
          >
            Hoy
          </button>
        </form>
        <div className="report-context">
          <p>
            Ingresos del <strong>{applied.get('from')}</strong> al <strong>{applied.get('to')}</strong>.
          </p>
          {pending && <p>Hay fechas sin consultar. La exportación usa el período consultado.</p>}
          <p>Las horas usan {data.settings.timezone}. La exportación respeta el nombre, estado y socio consultados.</p>
          {applied.get('person') && (
            <p>
              Mostrando las visitas del socio seleccionado. <a href="#attendance">Ver todos los socios</a>
            </p>
          )}
        </div>
        <div className="report-filters">
          <Field label="Buscar por nombre o documento">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={120}
              placeholder="Nombre o documento del socio"
            />
          </Field>
          <Field label="Estado">
            <select value={state} onChange={(e) => setState(e.target.value as GymSessionState)}>
              <option value="all">Todas las visitas</option>
              <option value="open">Dentro</option>
              <option value="closed">Finalizadas</option>
            </select>
          </Field>
        </div>
        {error ? (
          <div className="error-message" role="alert">
            {error}
            <button className="btn secondary" onClick={() => setRevision((v) => v + 1)}>
              Reintentar
            </button>
          </div>
        ) : busy ? (
          <Skeleton rows={5} />
        ) : view === 'hours' ? (
          <section className="gym-hours" aria-labelledby="gym-hours-heading">
            <div className="gym-hours-intro">
              <h2 id="gym-hours-heading">Horas por socio</h2>
              <p>
                Tiempo total y promedio de las visitas finalizadas en el período consultado. Las visitas abiertas no
                suman horas ni cuentan en los promedios.
              </p>
              <p>
                Los cierres automáticos se incluyen como tiempo estimado y se detallan en cada total. El promedio diario
                usa solo los días de entrada con al menos una visita finalizada.
              </p>
              <p role="status">
                <strong>{summaries.length}</strong> {summaries.length === 1 ? 'socio' : 'socios'} con visitas para estos
                filtros.
              </p>
            </div>
            <RecordList
              rows={summaries}
              getKey={(row) => row.person_id}
              state={{ status: 'ready' }}
              emptyText="No hay socios con visitas para estos filtros. Cambia las fechas, la búsqueda o el estado."
              headers={
                <tr>
                  <th scope="col">Socio</th>
                  <th scope="col">Total finalizado</th>
                  <th scope="col">Promedio por visita</th>
                  <th scope="col">Visitas finalizadas</th>
                  <th scope="col">Promedio por día de asistencia</th>
                  <th scope="col">Abiertas</th>
                </tr>
              }
              renderDesktopRow={(row) => (
                <>
                  <td>
                    <strong>{row.person_name}</strong>
                    <small>{row.document || 'Sin documento'}</small>
                  </td>
                  <td>
                    <strong className="gym-hours-total">{hours(row.completed_ms)}</strong>
                    {estimates(row)}
                  </td>
                  <td>{hours(row.average_visit_ms)}</td>
                  <td>
                    <strong>{row.completed_visits}</strong>
                    <small>
                      En {row.completed_days} {row.completed_days === 1 ? 'día' : 'días'}
                    </small>
                  </td>
                  <td>{hours(row.average_day_ms)}</td>
                  <td>
                    <span className="gym-hours-open">{row.open_visits}</span>
                    <small>Sin sumar horas</small>
                  </td>
                </>
              )}
              renderMobileItem={(row) => (
                <>
                  <header>
                    <div>
                      <strong>{row.person_name}</strong>
                      <small>{row.document || 'Sin documento'}</small>
                    </div>
                  </header>
                  <div className="gym-hours-mobile-total">
                    <span>Total finalizado</span>
                    <strong>{hours(row.completed_ms)}</strong>
                    {estimates(row)}
                  </div>
                  <dl>
                    <dt>Promedio por visita</dt>
                    <dd>{hours(row.average_visit_ms)}</dd>
                    <dt>Visitas finalizadas</dt>
                    <dd>{row.completed_visits}</dd>
                    <dt>Días con visitas finalizadas</dt>
                    <dd>{row.completed_days}</dd>
                    <dt>Promedio por día de asistencia</dt>
                    <dd>{hours(row.average_day_ms)}</dd>
                    <dt>Visitas abiertas</dt>
                    <dd>{row.open_visits} (sin sumar horas)</dd>
                  </dl>
                </>
              )}
            />
          </section>
        ) : (
          <>
            <p className="gym-visits-summary" role="status">
              {filtered.length} visitas · {filtered.length - closed.length} dentro · Promedio de visitas cerradas:{' '}
              {closed.length ? durationLabel(0, total / closed.length, now) : 'Sin salidas registradas'}
            </p>
            <RecordList
              rows={filtered}
              getKey={(row) => row.id}
              state={{ status: 'ready' }}
              emptyText="No hay visitas para estos filtros. Registra una entrada en Recepción."
              headers={
                <tr>
                  <th>Socio / persona</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Duración</th>
                  <th>Estado</th>
                  {data.user?.role === 'admin' && <th>Acciones</th>}
                </tr>
              }
              renderDesktopRow={(row) => (
                <>
                  <td>
                    <strong>{row.person_name}</strong>
                    <small>
                      {row.local_date} · {row.zone_name}
                    </small>
                  </td>
                  <td>{stamp(row.entry_at, data.settings.timezone, true)}</td>
                  <td>{exit(row)}</td>
                  <td>
                    <strong className="gym-duration">{durationLabel(row.entry_at, row.exit_at, now)}</strong>
                    <small>
                      {row.exit_at === null
                        ? 'En curso'
                        : row.auto_closed
                          ? 'Tiempo estimado'
                          : 'Permanencia registrada'}
                    </small>
                  </td>
                  <td>{status(row)}</td>
                  {data.user?.role === 'admin' && <td>{correct(row)}</td>}
                </>
              )}
              renderMobileItem={(row) => (
                <>
                  <header>
                    <div>
                      <strong>{row.person_name}</strong>
                      <small>{row.local_date}</small>
                    </div>
                    {status(row)}
                  </header>
                  <dl>
                    <dt>Entrada</dt>
                    <dd>{stamp(row.entry_at, data.settings.timezone, true)}</dd>
                    <dt>Salida</dt>
                    <dd>{exit(row)}</dd>
                    <dt>Duración{row.auto_closed ? ' estimada' : ''}</dt>
                    <dd>
                      {durationLabel(row.entry_at, row.exit_at, now)}
                      {row.exit_at === null ? ' (en curso)' : ''}
                    </dd>
                    <dt>Zona</dt>
                    <dd>{row.zone_name}</dd>
                  </dl>
                  {correct(row)}
                </>
              )}
            />
          </>
        )}
      </section>
      <p className="helper">
        Las visitas pertenecen al día de entrada. Las salidas automáticas se señalan como estimadas. Consulta hasta 93
        días por período.
      </p>
      {selected && Correction && data.user?.role === 'admin' && (
        <Correction
          key={selected.id}
          row={selected}
          timezone={data.settings.timezone}
          onClose={() => setSelected(null)}
          onComplete={() => {
            setSelected(null);
            setRevision((value) => value + 1);
            notify('Horas de la visita corregidas');
          }}
        />
      )}
    </>
  );
}
