import { useEffect, useState } from 'react';
import { api } from './api';
import { Field, Form, type Notify } from './ui';

export default function RecoveryKey({ notify }: { notify: Notify }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    api<{ configured: boolean }>('auth/recovery', 'GET', undefined, abort.signal)
      .then((v) => setConfigured(v.configured))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, []);
  return (
    <section className="panel padded" style={{ marginTop: 24 }}>
      <h3>Recuperación del administrador principal</h3>
      <p>
        Guarda una clave para restablecer tu contraseña desde esta computadora si la olvidas. Cada clave sirve una sola
        vez.
      </p>
      {error ? (
        <p className="helper">{error}</p>
      ) : configured === null ? (
        <p role="status">Consultando recuperación…</p>
      ) : (
        <>
          <p className="helper">
            {configured
              ? 'Ya tienes una clave de recuperación. Generar otra invalida la anterior.'
              : 'Todavía no generaste una clave de recuperación.'}
          </p>
          <Form
            label={configured ? 'Generar nueva clave de recuperación' : 'Crear clave de recuperación'}
            onSubmit={async (form) => {
              const result = await api<{ code: string }>('auth/recovery', 'POST', { current: form.get('current') });
              setCode(result.code);
              setConfigured(true);
              notify('Guarda tu clave de recuperación antes de cerrar este apartado.');
            }}
          >
            <Field label="Contraseña actual para generar la clave">
              <input name="current" type="password" autoComplete="current-password" required maxLength={200} />
            </Field>
          </Form>
        </>
      )}
      {code && (
        <div role="status">
          <Field
            label="Clave de recuperación recién creada"
            hint="Se muestra ahora; el sistema conserva únicamente su hash."
          >
            <input value={code} readOnly />
          </Field>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    `GymPASS: clave de recuperación del administrador\r\n${code}\r\nGuárdala fuera de esta computadora. Una nueva clave invalida esta.\r\n`,
                  ],
                  { type: 'text/plain;charset=utf-8' },
                ),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = 'GymPASS-clave-recuperacion.txt';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Descargar clave de recuperación
          </button>
        </div>
      )}
    </section>
  );
}
