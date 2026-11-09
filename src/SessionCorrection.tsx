import { useState } from 'react';
import { localParts, zonedTime, type GymSession } from '../lib/domain';
import { api } from './api';
import { Field, Form, Modal } from './ui';

type Props = {
  row: GymSession;
  timezone: string;
  onClose: () => void;
  onComplete: () => void;
};

function localInput(at: number, timezone: string) {
  const date = new Date(at);
  const parts = localParts(date, timezone);
  return `${parts.date}T${parts.time}:${date.toISOString().slice(17, 23)}`;
}

function inputTime(value: string, timezone: string, original: number | null): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) throw Error('Indica una fecha y hora válidas.');
  // Browsers can omit zero seconds and fractions; preserve the original instant even in a repeated DST hour.
  const normalized = `${match[1]}T${match[2]}:${match[3] || '00'}.${(match[4] || '').padEnd(3, '0')}`;
  if (original !== null && normalized === localInput(original, timezone)) return original;
  const at =
    zonedTime(match[1], match[2], timezone) + Number(match[3] || 0) * 1000 + Number((match[4] || '').padEnd(3, '0'));
  const parts = localParts(new Date(at), timezone);
  if (parts.date !== match[1] || parts.time !== match[2])
    throw Error('La hora indicada no existe en la zona horaria del gimnasio.');
  return at;
}

export default function SessionCorrection({ row, timezone, onClose, onComplete }: Props) {
  const [saving, setSaving] = useState(false);
  const close = () => {
    if (!saving) onClose();
  };
  return (
    <Modal title="Corregir horas de la visita" onClose={close}>
      <p>
        <strong>{row.person_name}</strong> · {row.zone_name}
      </p>
      <p className="helper">Las fechas y horas usan {timezone}. La corrección y su motivo quedarán en la auditoría.</p>
      {row.auto_closed === 1 && (
        <p className="helper">Al guardar, la salida estimada se registrará como una salida corregida.</p>
      )}
      <Form
        label="Guardar corrección"
        onCancel={close}
        disabled={saving}
        onSubmit={async (form) => {
          const reason = String(form.get('reason') || '').trim();
          if (!reason || reason.length > 1000) throw Error('Escribe un motivo de entre 1 y 1000 caracteres.');
          const entry_at = inputTime(String(form.get('entry_at') || ''), timezone, row.entry_at);
          const exitValue = String(form.get('exit_at') || '');
          if (!exitValue && row.exit_at !== null) throw Error('No se puede eliminar una salida ya registrada.');
          const exit_at = exitValue ? inputTime(exitValue, timezone, row.exit_at) : null;
          if (entry_at > Date.now() || (exit_at !== null && (exit_at > Date.now() || exit_at < entry_at)))
            throw Error('Las horas no pueden estar en el futuro y la salida debe ser igual o posterior a la entrada.');
          setSaving(true);
          try {
            await api<{ ok: true }>(`gym-sessions/${row.id}/correct`, 'POST', { entry_at, exit_at, reason });
            onComplete();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field label="Entrada">
          <input
            type="datetime-local"
            name="entry_at"
            required
            step="0.001"
            defaultValue={localInput(row.entry_at, timezone)}
            data-autofocus
          />
        </Field>
        <Field
          label="Salida"
          hint={row.exit_at === null ? 'Deja la salida vacía para mantener la visita pendiente.' : undefined}
        >
          <input
            type="datetime-local"
            name="exit_at"
            required={row.exit_at !== null}
            step="0.001"
            defaultValue={row.exit_at === null ? '' : localInput(row.exit_at, timezone)}
          />
        </Field>
        <Field label="Motivo de la corrección">
          <textarea name="reason" required maxLength={1000} rows={3} />
        </Field>
      </Form>
    </Modal>
  );
}
