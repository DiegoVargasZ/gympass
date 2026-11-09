import { useEffect, useState } from 'react';
import { searchFold, type AccessEvent, type Bootstrap } from '../lib/domain';
import { api } from './api';
import { Avatar, Field, RecordList, Skeleton, stamp } from './ui';

import { durationLabel } from '../lib/gym';

export function useGymClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function GymPresence({ data }: { data: Bootstrap }) {
  const [rows, setRows] = useState<AccessEvent[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('oldest');
  const now = useGymClock();
  useEffect(() => {
    const abort = new AbortController();
    api<AccessEvent[]>('presence', 'GET', undefined, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setRows(value);
        setError('');
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [data, revision]);
  const visible = rows
    .filter((row) => searchFold(row.person_name).includes(searchFold(search)))
    .sort((a, b) => (sort === 'oldest' ? a.occurred_at - b.occurred_at : b.occurred_at - a.occurred_at));
  return (
    <section className="panel gym-presence">
      <div className="panel-heading">
        <div>
          <h2>Dentro ahora</h2>
          <p>Desde qué hora están y cuánto llevan. Se actualiza solo.</p>
        </div>
        <p className="presence-count" aria-live="polite">
          <strong>{busy ? '…' : rows.length}</strong> {rows.length === 1 ? 'persona dentro' : 'personas dentro'}
        </p>
      </div>
      <div className="report-filters">
        <Field label="Buscar dentro del gimnasio">
          <input
            type="search"
            maxLength={120}
            placeholder="Nombre del socio"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="Ordenar por">
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="oldest">Quien lleva más tiempo</option>
            <option value="newest">Quien llegó último</option>
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
        <Skeleton rows={3} />
      ) : (
        <RecordList
          rows={visible}
          getKey={(row) => row.id}
          state={{ status: 'ready' }}
          emptyText={
            search
              ? 'No hay personas dentro con ese nombre.'
              : 'No hay personas dentro. Registra una entrada desde Recepción.'
          }
          headers={
            <tr>
              <th>Persona</th>
              <th>Entrada</th>
              <th>Tiempo dentro</th>
              {data.user.role !== 'viewer' && <th>Acción</th>}
            </tr>
          }
          renderDesktopRow={(row) => (
            <>
              <td>
                <div className="person-cell">
                  <Avatar name={row.person_name} personId={row.person_id} photoPath={row.photo_path} />
                  <div>
                    <strong>{row.person_name}</strong>
                    <small>{row.zone_name}</small>
                  </div>
                </div>
              </td>
              <td>{stamp(row.occurred_at, data.settings.timezone, true)}</td>
              <td>
                <strong className="gym-duration">{durationLabel(row.occurred_at, null, now)}</strong>
              </td>
              {data.user.role !== 'viewer' && (
                <td>
                  <a
                    className="btn secondary small"
                    href={
                      '#access?person=' +
                      encodeURIComponent(row.person_id || '') +
                      '&direction=exit&zone=' +
                      encodeURIComponent(row.zone_id)
                    }
                  >
                    Registrar salida
                  </a>
                </td>
              )}
            </>
          )}
          renderMobileItem={(row) => (
            <>
              <header>
                <Avatar name={row.person_name} personId={row.person_id} photoPath={row.photo_path} />
                <strong>{row.person_name}</strong>
              </header>
              <dl>
                <dt>Entrada</dt>
                <dd>{stamp(row.occurred_at, data.settings.timezone, true)}</dd>
                <dt>Tiempo dentro</dt>
                <dd>{durationLabel(row.occurred_at, null, now)}</dd>
              </dl>
              {data.user.role !== 'viewer' && (
                <a
                  className="btn secondary"
                  href={
                    '#access?person=' +
                    encodeURIComponent(row.person_id || '') +
                    '&direction=exit&zone=' +
                    encodeURIComponent(row.zone_id)
                  }
                >
                  Registrar salida
                </a>
              )}
            </>
          )}
        />
      )}
    </section>
  );
}
