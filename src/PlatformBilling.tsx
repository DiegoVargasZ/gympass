import { useCallback, useEffect, useRef, useState } from 'react';
import { api, HttpError, NetworkError } from './api';
import { newRequestId } from './browser';
import { Empty, Field, Form, Modal, Skeleton } from './ui';
import type { BillingAccount, BillingCharge, BillingPayment, BillingPaymentInput } from '../server/platform-billing';
import './styles/platform-billing.css';

const money = (cents: number) =>
  new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(cents / 100);
const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(Date.now());
const states: Record<string, string> = {
  pending: 'Pendiente',
  partial: 'Parcial',
  paid: 'Pagado',
  overdue: 'Vencido',
  no_charge: 'Sin cargo',
};
const methods: Record<string, string> = { cash: 'Efectivo', transfer: 'Transferencia / QR', card: 'Tarjeta' };
function cents(value: FormDataEntryValue | null) {
  const normalized = String(value ?? '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw Error('Introduce un importe válido con hasta dos decimales.');
  const [whole, decimal = ''] = normalized.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('El importe debe ser positivo.');
  return amount;
}

function recoverPayment(storageKey: string): BillingPaymentInput | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (
      !stored ||
      typeof stored.request_id !== 'string' ||
      typeof stored.charge_id !== 'string' ||
      !Number.isSafeInteger(stored.amount_cents) ||
      stored.amount_cents <= 0 ||
      typeof stored.paid_on !== 'string' ||
      !['cash', 'transfer', 'card'].includes(stored.method) ||
      typeof stored.reference !== 'string'
    )
      return null;
    return {
      request_id: stored.request_id,
      charge_id: stored.charge_id,
      amount_cents: stored.amount_cents,
      paid_on: stored.paid_on,
      method: stored.method,
      reference: stored.reference,
    };
  } catch {
    return null;
  }
}

export default function PlatformBilling({
  gymId,
  gymName,
  userId,
  onPendingChange,
}: {
  gymId: string;
  gymName: string;
  userId: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const storageKey = `gympass-billing-pending:${gymId}:${userId}`;
  const [recovered, setRecovered] = useState(() => recoverPayment(storageKey));
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [configure, setConfigure] = useState(false);
  const [payment, setPayment] = useState<BillingCharge | null>(null);
  const [voiding, setVoiding] = useState<BillingPayment | null>(null);
  const path = 'platform/gyms/' + encodeURIComponent(gymId) + '/billing';
  const refresh = useCallback(async () => {
    try {
      setAccount(await api<BillingAccount>(path));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [path]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    onPendingChange?.(Boolean(recovered));
  }, [storageKey]);
  useEffect(() => {
    if (!recovered || !account) return;
    const charge = account.charges.find((entry) => entry.id === recovered.charge_id);
    if (charge) setPayment(charge);
    else setError('No encontramos el cargo del pago pendiente. Actualiza la cuenta para recuperar su confirmación.');
  }, [recovered, account]);
  if (!account)
    return error ? (
      <div role="alert">
        <p>{error}</p>
        <button className="btn secondary" onClick={() => void refresh()}>
          Reintentar
        </button>
      </div>
    ) : (
      <Skeleton rows={3} label="Consultando mensualidades" />
    );
  return (
    <div className="platform-billing">
      <div className="platform-billing-heading">
        <div>
          <h3>Cuenta de {gymName}</h3>
          <p>
            Saldo total: <strong>{money(account.balance_cents)}</strong>
          </p>
        </div>
        <div className="platform-actions">
          <button className="btn secondary" onClick={() => void refresh()}>
            Actualizar cuenta
          </button>
          <button className="btn secondary" onClick={() => setConfigure(true)}>
            {account.config ? 'Editar cuota' : 'Configurar cuota'}
          </button>
        </div>
      </div>
      <p className="helper">
        La deuda no suspende el servicio. La suspensión y reactivación se administran desde la ficha del gimnasio.
      </p>
      {account.config ? (
        <p>
          Cuota: {money(account.config.monthly_fee_cents)} al mes · Inicio: {account.config.start_month} · Vence el día{' '}
          {account.config.due_day}.
        </p>
      ) : (
        <p className="platform-notice">Sin configurar. Indica la cuota acordada para generar cargos.</p>
      )}
      {notice && (
        <p role="status" className="platform-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!account.charges.length ? (
        <Empty
          title="Sin mensualidades"
          text="Los cargos aparecen desde el mes de inicio configurado durante los períodos de servicio activo."
        />
      ) : (
        <div className="table-scroll">
          <table>
            <caption>Mensualidades de GymPASS</caption>
            <thead>
              <tr>
                <th>Mes</th>
                <th>Vence</th>
                <th>Cargo</th>
                <th>Pagado</th>
                <th>Saldo</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {account.charges.map((charge) => (
                <tr key={charge.id}>
                  <th scope="row">{charge.month}</th>
                  <td>{charge.due_on}</td>
                  <td>{money(charge.amount_cents)}</td>
                  <td>{money(charge.paid_cents)}</td>
                  <td>{money(charge.balance_cents)}</td>
                  <td>{states[charge.status]}</td>
                  <td>
                    {charge.balance_cents > 0 && (
                      <button className="btn secondary" onClick={() => setPayment(charge)}>
                        Registrar pago <span className="sr-only">de {charge.month}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Historial de pagos</h3>
      {!account.payments.length ? (
        <Empty text="Los pagos registrados y sus anulaciones aparecerán aquí." />
      ) : (
        <div className="platform-payment-list">
          {account.payments.map((entry) => (
            <article key={entry.id} className="platform-payment">
              <div>
                <strong>
                  {money(entry.amount_cents)} · {account.charges.find((c) => c.id === entry.charge_id)?.month}
                </strong>
                <p>
                  {entry.paid_on} · {methods[entry.method]} · {entry.actor_name}
                </p>
                {entry.reference && <p>Referencia: {entry.reference}</p>}
                {entry.voided_at && (
                  <p>
                    Anulado: {entry.void_reason} · {new Date(entry.voided_at).toLocaleString('es-BO')}
                  </p>
                )}
              </div>
              {!entry.voided_at && (
                <button className="btn secondary" onClick={() => setVoiding(entry)}>
                  Anular pago
                </button>
              )}
            </article>
          ))}
        </div>
      )}
      {configure && (
        <Modal title="Configurar mensualidad" onClose={() => setConfigure(false)}>
          <Form
            label="Guardar cuota"
            onCancel={() => setConfigure(false)}
            onSubmit={async (form) => {
              const next = await api<BillingAccount>(path, 'PATCH', {
                monthly_fee_cents: cents(form.get('fee')),
                start_month: form.get('start_month'),
                due_day: Number(form.get('due_day')),
              });
              setAccount(next);
              setConfigure(false);
              setNotice('Cuota guardada. Los cargos existentes conservan su importe.');
            }}
          >
            <Field label="Cuota mensual (BOB)">
              <input
                name="fee"
                inputMode="decimal"
                required
                defaultValue={account.config ? (account.config.monthly_fee_cents / 100).toFixed(2) : ''}
              />
            </Field>
            <Field label="Mes de inicio">
              <input
                name="start_month"
                type="month"
                min="2000-01"
                max="2199-12"
                required
                defaultValue={account.config?.start_month ?? localDate().slice(0, 7)}
              />
            </Field>
            <Field label="Día de vencimiento">
              <input
                name="due_day"
                type="number"
                min={1}
                max={28}
                required
                defaultValue={account.config?.due_day ?? 1}
              />
            </Field>
            <p className="helper">
              El primer mes se cobra completo. Suspender o archivar conserva el cargo del mes actual y detiene los
              siguientes.
            </p>
          </Form>
        </Modal>
      )}
      {payment && (
        <PaymentForm
          charge={payment}
          path={path}
          storageKey={storageKey}
          onClose={() => setPayment(null)}
          onPendingChange={onPendingChange}
          onRefresh={refresh}
          onSaved={async () => {
            setRecovered(null);
            setPayment(null);
            setNotice('Pago registrado.');
            await refresh();
          }}
        />
      )}
      {voiding && (
        <Modal title="Anular pago" onClose={() => setVoiding(null)}>
          <p>
            Se conservará el pago de {money(voiding.amount_cents)} en el historial y se reabrirá el saldo
            correspondiente.
          </p>
          <Form
            label="Anular pago"
            onCancel={() => setVoiding(null)}
            onSubmit={async (form) => {
              await api(path + '/payments/' + encodeURIComponent(voiding.id) + '/void', 'POST', {
                reason: form.get('reason'),
              });
              setVoiding(null);
              setNotice('Pago anulado.');
              await refresh();
            }}
          >
            <Field label="Motivo de anulación">
              <textarea name="reason" required minLength={3} maxLength={1000} rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
    </div>
  );
}

function PaymentForm({
  charge,
  path,
  storageKey,
  onClose,
  onSaved,
  onPendingChange,
  onRefresh,
}: {
  charge: BillingCharge;
  path: string;
  storageKey: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [recovered] = useState(() => recoverPayment(storageKey));
  const [requestId] = useState(() => recovered?.request_id ?? newRequestId());
  const pending = useRef<BillingPaymentInput | null>(recovered);
  const submittingRef = useRef(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered));
  const [submitting, setSubmitting] = useState(false);
  const [closeNotice, setCloseNotice] = useState('');
  const locked = uncertain || submitting;
  const clearPending = () => {
    pending.current = null;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const close = () => {
    if (pending.current || submittingRef.current)
      setCloseNotice('Reintenta el mismo pago antes de cerrar para confirmar su resultado.');
    else onClose();
  };
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [locked]);
  return (
    <Modal title={'Registrar pago · ' + charge.month} onClose={close} protectChanges={!locked}>
      <p>
        Saldo del cargo: <strong>{money(charge.balance_cents)}</strong>
      </p>
      <Form
        label={uncertain ? 'Reintentar el mismo pago' : 'Registrar pago'}
        onCancel={locked ? undefined : close}
        unsaved={locked || undefined}
        onSubmit={async (form) => {
          if (submittingRef.current) return;
          const alreadyPending = pending.current !== null;
          if (!pending.current)
            pending.current = {
              request_id: requestId,
              charge_id: charge.id,
              amount_cents: cents(form.get('amount')),
              paid_on: String(form.get('paid_on')),
              method: String(form.get('method')) as BillingPaymentInput['method'],
              reference: String(form.get('reference') ?? ''),
            };
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
          } catch {
            if (!alreadyPending) pending.current = null;
            throw Error(
              'No se pudo guardar la confirmación pendiente en este navegador. Habilita el almacenamiento de sesión antes de registrar el pago.',
            );
          }
          submittingRef.current = true;
          setSubmitting(true);
          onPendingChange?.(true);
          try {
            await api(path + '/payments', 'POST', pending.current);
            clearPending();
            setUncertain(false);
            onPendingChange?.(false);
            await onSaved();
          } catch (cause) {
            if (
              cause instanceof NetworkError ||
              (cause instanceof HttpError && (cause.status >= 500 || [401, 403].includes(cause.status)))
            )
              setUncertain(true);
            else {
              clearPending();
              setUncertain(false);
              onPendingChange?.(false);
            }
            await onRefresh();
            throw cause;
          } finally {
            submittingRef.current = false;
            setSubmitting(false);
          }
        }}
      >
        {uncertain && (
          <p role="alert" className="platform-notice">
            No pudimos confirmar la respuesta. Reintenta el mismo pago; conserva su importe y su identificador para
            evitar duplicados.
          </p>
        )}
        {closeNotice && <p role="status">{closeNotice}</p>}
        <fieldset disabled={locked} className="billing-payment-fields">
          <Field label="Importe recibido (BOB)">
            <input
              name="amount"
              inputMode="decimal"
              required
              defaultValue={((recovered?.amount_cents ?? charge.balance_cents) / 100).toFixed(2)}
            />
          </Field>
          <Field label="Fecha de pago">
            <input
              name="paid_on"
              type="date"
              required
              max={localDate()}
              defaultValue={recovered?.paid_on ?? localDate()}
            />
          </Field>
          <Field label="Método">
            <select name="method" defaultValue={recovered?.method ?? 'cash'}>
              <option value="cash">Efectivo</option>
              <option value="transfer">Transferencia / QR</option>
              <option value="card">Tarjeta</option>
            </select>
          </Field>
          <Field label="Referencia (opcional)">
            <input name="reference" maxLength={300} defaultValue={recovered?.reference ?? ''} />
          </Field>
        </fieldset>
      </Form>
    </Modal>
  );
}

type Summary = {
  month: string;
  amount_cents: number;
  paid_cents: number;
  balance_cents: number;
  rows: {
    gym_id: string;
    name: string;
    archived: boolean;
    configured: boolean;
    amount_cents: number;
    paid_cents: number;
    balance_cents: number;
    total_balance_cents: number;
    status: string;
  }[];
};
export function PlatformBillingSummary({ onOpen }: { onOpen: (gym: { id: string; name: string }) => void }) {
  const [month, setMonth] = useState(() => localDate().slice(0, 7));
  const [filter, setFilter] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError('');
    void api<Summary>('platform/billing?month=' + encodeURIComponent(month))
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [month, refreshKey]);
  const rows = summary?.rows.filter((row) => row.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  return (
    <section className="panel platform-billing-summary" aria-label="Resumen de mensualidades">
      <div className="platform-billing-heading">
        <h2>Mensualidades de GymPASS</h2>
        <button className="btn secondary" onClick={() => setRefreshKey((value) => value + 1)}>
          Actualizar resumen
        </button>
      </div>
      <div className="platform-billing-filters">
        <Field label="Mes">
          <input
            type="month"
            value={month}
            min="2000-01"
            max="2199-12"
            required
            onChange={(event) => {
              if (event.target.value) setMonth(event.target.value);
            }}
          />
        </Field>
        <Field label="Buscar gimnasio">
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="error-message">
          {error}
        </p>
      ) : !summary ? (
        <Skeleton rows={2} label="Consultando resumen mensual" />
      ) : (
        <>
          <p>
            Cargos: <strong>{money(summary.amount_cents)}</strong> · Pagado:{' '}
            <strong>{money(summary.paid_cents)}</strong> · Saldo del mes:{' '}
            <strong>{money(summary.balance_cents)}</strong>
          </p>
          {!rows.length ? (
            <Empty text="No hay gimnasios que coincidan con la búsqueda." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Gimnasio</th>
                    <th>Cargo del mes</th>
                    <th>Pagado</th>
                    <th>Saldo del mes</th>
                    <th>Estado</th>
                    <th>Deuda total</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.gym_id}>
                      <th scope="row">
                        {row.name}
                        {row.archived ? ' (archivado)' : ''}
                      </th>
                      <td>{money(row.amount_cents)}</td>
                      <td>{money(row.paid_cents)}</td>
                      <td>{money(row.balance_cents)}</td>
                      <td>{row.configured ? states[row.status] : 'Sin configurar'}</td>
                      <td>{money(row.total_balance_cents)}</td>
                      <td>
                        <button className="btn secondary" onClick={() => onOpen({ id: row.gym_id, name: row.name })}>
                          Ver cuenta
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
