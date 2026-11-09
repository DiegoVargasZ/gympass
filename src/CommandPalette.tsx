import { useMemo, useState } from 'react';
import type { Bootstrap } from '../lib/domain';
import { Modal } from './ui';
import { usePeople } from './usePeople';

export default function CommandPalette({
  data,
  pages,
  onClose,
}: {
  data: Bootstrap;
  pages: readonly (readonly [string, string, unknown])[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const directory = usePeople({ q: query.trim(), limit: 6, enabled: !!query.trim() });
  const options = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const navigation = pages
      .filter(
        ([id, label]) =>
          (id !== 'access' || data.user.role !== 'viewer') &&
          (id !== 'renewals' || data.user.role === 'admin') &&
          (id !== 'credentials' || data.user.role !== 'viewer') &&
          label.toLocaleLowerCase().includes(q),
      )
      .map(([id, label]) => ({ key: id, label, hint: 'Ir a página', hash: '#' + id }));
    const people = q
      ? directory.rows.flatMap((person) => [
          {
            key: 'person-' + person.id,
            label: person.name,
            hint: 'Buscar persona · ' + person.document,
            hash: '#people?q=' + encodeURIComponent(person.document),
          },
          ...(data.user.role !== 'viewer'
            ? [
                {
                  key: 'access-' + person.id,
                  label: 'Registrar acceso de ' + person.name,
                  hint: 'Registro manual con motivo',
                  hash: '#access?person=' + encodeURIComponent(person.id),
                },
              ]
            : []),
        ])
      : [];
    return [...navigation, ...people];
  }, [query, pages, data.user.role, directory.rows]);
  function choose(index: number) {
    const option = options[index];
    if (option) {
      location.hash = option.hash;
      onClose();
    }
  }
  return (
    <Modal title="Buscar o navegar" onClose={onClose}>
      <input
        data-autofocus
        className="command-input"
        aria-label="Buscar página o persona"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="command-options"
        aria-activedescendant={options.length ? 'command-option-' + Math.min(active, options.length - 1) : undefined}
        value={query}
        maxLength={120}
        placeholder="Una página, nombre o documento…"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = options.length
              ? (active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
              : 0;
            setActive(index);
            document.getElementById('command-option-' + index)?.scrollIntoView({ block: 'nearest' });
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(active);
          }
        }}
      />
      <div className="command-options" id="command-options" role="listbox" aria-label="Resultados">
        {options.map((option, index) => (
          <button
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            id={'command-option-' + index}
            key={option.key}
            onClick={() => choose(index)}
          >
            <strong>{option.label}</strong>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>
      {!options.length && <p className="helper">Sin coincidencias.</p>}
      {directory.busy && (
        <p className="helper" role="status">
          Buscando personas…
        </p>
      )}
      {directory.error && (
        <p className="error-message" role="alert">
          {directory.error}
        </p>
      )}
      <p className="helper">↑ ↓ para elegir · Enter para abrir · Esc para cerrar</p>
    </Modal>
  );
}
