import { useEffect, useState } from 'react';
import type { SavedReport } from '../lib/domain';
import { api } from './api';
import { Field, Form, Skeleton, type Notify } from './ui';

export default function SavedReports({
  kind,
  query,
  onApply,
  notify,
}: {
  kind: 'events' | 'workdays' | 'visits';
  query: string;
  onApply: (query: string) => void;
  notify: Notify;
}) {
  const [rows, setRows] = useState<SavedReport[]>([]),
    [name, setName] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState('');
  async function load() {
    const values = await api<SavedReport[]>('saved-reports');
    setRows(values.filter((row) => row.kind === kind));
    setError('');
  }
  useEffect(() => {
    const abort = new AbortController();
    api<SavedReport[]>('saved-reports', 'GET', undefined, abort.signal)
      .then((values) => setRows(values.filter((row) => row.kind === kind)))
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [kind]);
  return (
    <details className="panel padded saved-reports">
      <summary>Mis consultas guardadas</summary>
      <p className="helper">Se guardan el período y los filtros consultados. Cada usuario ve sus propias consultas.</p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <Skeleton rows={2} />
      ) : !rows.length ? (
        <p>No tienes consultas guardadas en esta sección.</p>
      ) : (
        <ul className="saved-query-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                className="btn secondary"
                aria-label={'Abrir ' + row.name}
                onClick={() => {
                  try {
                    onApply(row.query);
                    notify('Consulta aplicada');
                  } catch (error) {
                    notify((error as Error).message, true);
                  }
                }}
              >
                {row.name}
              </button>
              <button
                className="btn secondary small"
                aria-label={'Eliminar ' + row.name}
                disabled={!!deleting}
                onClick={async () => {
                  setDeleting(row.id);
                  try {
                    await api('saved-reports/' + row.id, 'DELETE', {});
                    await load();
                    notify('Consulta eliminada');
                  } catch (error) {
                    notify((error as Error).message, true);
                  } finally {
                    setDeleting('');
                  }
                }}
              >
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      )}
      <Form
        label="Guardar consulta"
        onSubmit={async () => {
          await api('saved-reports', 'POST', { name, kind, query });
          await load();
          setName('');
          notify('Consulta guardada');
        }}
      >
        <Field label="Nombre de la consulta">
          <input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Por ejemplo, accesos de recepción"
          />
        </Field>
      </Form>
    </details>
  );
}
