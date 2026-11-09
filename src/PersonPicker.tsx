import { useEffect, useState } from 'react';
import type { PersonSummary } from '../lib/domain';
import { api } from './api';
import { usePeople } from './usePeople';
import { Avatar, Field } from './ui';

export default function PersonPicker({ initialId = '' }: { initialId?: string }) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(initialId),
    [person, setPerson] = useState<PersonSummary | null>(null),
    [error, setError] = useState('');
  const people = usePeople({ q: query, page, limit: 20 });
  useEffect(() => {
    let live = true;
    if (!selected) {
      setPerson(null);
      setError('');
      return;
    }
    void api<PersonSummary>('people/' + encodeURIComponent(selected) + '/summary')
      .then((value) => {
        if (live) {
          setPerson(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
    };
  }, [selected]);
  const options = person && !people.rows.some((row) => row.id === person.id) ? [person, ...people.rows] : people.rows;
  return (
    <div className="person-picker">
      <Field label="Buscar persona" hint="Busca por nombre, documento o área.">
        <input
          type="search"
          value={query}
          maxLength={120}
          placeholder="Escribe para buscar…"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
            setSelected('');
            setPerson(null);
          }}
        />
      </Field>
      <Field label="Persona">
        <select
          name="person_id"
          required
          value={selected}
          onChange={(event) => {
            setPerson(null);
            setSelected(event.target.value);
          }}
        >
          <option value="" disabled>
            {people.busy ? 'Buscando…' : 'Selecciona una persona'}
          </option>
          {options.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name} · {row.document}
            </option>
          ))}
        </select>
      </Field>
      {person && (
        <div className="person-cell picker-selection">
          <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />
          <span>
            {person.name}
            <small>{person.document}</small>
          </span>
        </div>
      )}
      {people.total > 20 && (
        <div className="picker-pages">
          <button
            className="text-btn"
            type="button"
            disabled={page === 1 || people.busy}
            onClick={() => setPage((value) => value - 1)}
          >
            Anteriores
          </button>
          <span>
            {page} / {Math.ceil(people.total / 20)}
          </span>
          <button
            className="text-btn"
            type="button"
            disabled={page * 20 >= people.total || people.busy}
            onClick={() => setPage((value) => value + 1)}
          >
            Siguientes
          </button>
        </div>
      )}
      {(people.error || error) && (
        <p className="error-message" role="alert">
          {people.error || error}
        </p>
      )}
      {!people.busy && !people.error && !people.total && query && (
        <p className="helper">No encontramos coincidencias.</p>
      )}
    </div>
  );
}
