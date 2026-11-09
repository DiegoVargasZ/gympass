import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import type { ActivationStatus } from '../lib/client-types';
import { api } from './api';
import { Badge, Field, Form, Modal, Skeleton, type Notify } from './ui';
import { copyText } from './browser';

export default function SystemTools({
  notify,
  section = 'all',
}: {
  notify: Notify;
  section?: 'activation' | 'reset' | 'all';
}) {
  const [license, setLicense] = useState<ActivationStatus | null>(null);
  const [error, setError] = useState('');
  const [reset, setReset] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    if (section === 'reset') return;
    const abort = new AbortController();
    api<ActivationStatus>('activation', 'GET', undefined, abort.signal)
      .then(setLicense)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [section]);
  return (
    <>
      {section !== 'reset' && (
        <section className="panel padded">
          <div className="section-heading">
            <div>
              <h2>
                <KeyRound size={21} /> Activación de GymPASS
              </h2>
              <p>Licencia por meses o permanente. La misma activación habilita los teléfonos conectados.</p>
            </div>
            {license && (
              <Badge tone={license.state === 'active' ? 'green' : license.state === 'expired' ? 'red' : 'amber'}>
                {license.state === 'active'
                  ? license.licenseType === 'permanent'
                    ? 'Permanente'
                    : `${license.days} días disponibles`
                  : license.state === 'expired'
                    ? 'Activación vencida'
                    : `${license.days} días de prueba`}
              </Badge>
            )}
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {!license && !error && <Skeleton rows={2} label="Consultando licencia" />}
          {license && (
            <>
              <div className="license-details">
                <p>
                  <strong>
                    {license.licenseType === 'permanent'
                      ? 'Licencia permanente'
                      : license.licenseType === 'monthly'
                        ? `Licencia por ${license.months} ${license.months === 1 ? 'mes' : 'meses'}`
                        : 'Período de prueba'}
                  </strong>
                </p>
                <p className="helper">
                  {license.expiresAt === null
                    ? 'Sin fecha de vencimiento.'
                    : `Vence el ${new Date(license.expiresAt).toLocaleString('es-BO', { dateStyle: 'long', timeStyle: 'short' })}.`}
                </p>
              </div>
              <Field label="ID de esta computadora" hint="Envíalo a tu proveedor para que genere la clave.">
                <input value={license.machineId} readOnly />
              </Field>
              <button
                className="btn secondary"
                type="button"
                onClick={async () => {
                  try {
                    await copyText(license.machineId);
                    notify('ID copiado');
                  } catch {
                    notify('Selecciona y copia el ID de la computadora.', true);
                  }
                }}
              >
                Copiar ID
              </button>
              {license.licenseType !== 'permanent' && (
                <Form
                  label={license.licenseType === 'monthly' ? 'Renovar licencia' : 'Activar licencia'}
                  onSubmit={async () => {
                    const result = await api<ActivationStatus>('activation', 'POST', { code });
                    setLicense(result);
                    setCode('');
                    notify(
                      result.licenseType === 'permanent'
                        ? 'GymPASS activado permanentemente'
                        : `Licencia de GymPASS actualizada: ${result.months} meses`,
                    );
                    window.dispatchEvent(new Event('activation-changed'));
                  }}
                >
                  <Field
                    label="Clave de activación"
                    hint="La clave indica la duración. Las claves por meses se canjean en 7 días y suman tiempo al saldo actual."
                  >
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      inputMode="numeric"
                      pattern="[0-9]{8}"
                      minLength={8}
                      maxLength={8}
                      autoComplete="off"
                      required
                      placeholder="00000000"
                    />
                  </Field>
                </Form>
              )}
            </>
          )}
        </section>
      )}
      {section !== 'activation' && (
        <section className="panel padded">
          <div className="section-heading">
            <div>
              <h2>
                <Trash2 size={21} /> Borrar datos del gimnasio
              </h2>
              <p>
                Deja el sistema listo para empezar de nuevo, conservando la cuenta y contraseña del administrador
                principal y la activación.
              </p>
            </div>
          </div>
          <p>
            Se borran socios, credenciales, visitas, movimientos, usuarios adicionales, reportes, zonas, horarios,
            fotos, logos y fondos. Se crea un respaldo completo antes de borrar y se conservan los respaldos existentes.
          </p>
          <p className="helper">
            Solo el administrador principal puede hacerlo desde esta computadora. Se cerrarán todas las sesiones,
            incluidas las de los teléfonos.
          </p>
          <button
            className="btn danger"
            type="button"
            onClick={() => {
              setConfirmation('');
              setReset(true);
            }}
          >
            Borrar datos conservando administrador
          </button>
        </section>
      )}
      {reset && (
        <Modal title="Borrar datos conservando administrador" onClose={() => setReset(false)}>
          <p>
            Se eliminarán los datos del gimnasio y los demás usuarios. El administrador principal podrá volver a entrar
            con su correo y contraseña actuales. Si el respaldo falla, no se borrará nada.
          </p>
          <Form
            label="Crear respaldo y borrar datos"
            submitDisabled={confirmation !== 'BORRAR DATOS'}
            onCancel={() => setReset(false)}
            onSubmit={async (form) => {
              await api('system/reset', 'POST', { password: form.get('password'), confirm: confirmation });
              setReset(false);
              window.dispatchEvent(new Event('installation-reset'));
            }}
          >
            <Field label="Contraseña del administrador principal">
              <input name="password" type="password" autoComplete="current-password" required maxLength={200} />
            </Field>
            <Field label="Escribe BORRAR DATOS para confirmar">
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
                autoComplete="off"
              />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
