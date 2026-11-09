import { useEffect, useState } from 'react';
import { Modal } from './ui';
import { reviewAccessQueue, setAccessReview, useAccessQueue } from './offline';
import type { StoredAccess } from './offline-queue';

export default function QueueReview() {
  const queue = useAccessQueue();
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<StoredAccess[]>([]),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    reviewAccessQueue()
      .then((records) => {
        if (active) setRows(records);
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, queue]);
  async function change(record: StoredAccess) {
    const hold = !record.review_required;
    if (
      hold &&
      !confirm(
        'Apartar este movimiento permite enviar los posteriores y puede cambiar su orden. Comprueba el resultado y los movimientos de esta persona antes de continuar. El registro se conservará sin reenviarse.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await setAccessReview(record.request_id, hold);
      setRows(await reviewAccessQueue());
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open && !queue.pending && !queue.held) return null;
  return (
    <>
      {!!queue.held && <p role="status">{queue.held} movimientos apartados para revisión. No se reenviarán.</p>}
      <button
        className="btn secondary small"
        type="button"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        Revisar movimientos
      </button>
      {open && (
        <Modal title="Movimientos sin enviar" onClose={() => setOpen(false)}>
          <p>
            Solo se muestran los movimientos de esta cuenta e instalación. Apartar conserva el registro; reactivarlo
            conserva la misma clave para evitar duplicados.
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {loading && <p role="status">Consultando movimientos…</p>}
          {!loading && !rows.length && <p>No hay movimientos de esta cuenta pendientes de revisión.</p>}
          {rows.map((record) => (
            <article className="panel" key={record.request_id}>
              <strong>{record.person_name || 'Lectura de credencial'}</strong>
              <p>
                {record.direction === 'entry' ? 'Entrada' : record.direction === 'exit' ? 'Salida' : 'Automático'} ·{' '}
                {new Date(record.queued_at).toLocaleString()}
              </p>
              <p>{record.review_required ? 'Apartado para revisión' : 'Pendiente de envío'}</p>
              {record.last_error && <p className="error-message">{record.last_error}</p>}
              <button
                className="btn secondary small"
                type="button"
                disabled={busy || loading || queue.sending}
                onClick={() => void change(record)}
              >
                {record.review_required ? 'Reactivar envío' : 'Apartar para revisión'}
              </button>
            </article>
          ))}
        </Modal>
      )}
    </>
  );
}
