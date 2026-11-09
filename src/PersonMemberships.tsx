import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  planEndDate,
  type MembershipSummary,
  type PlanGate,
  type PosCatalog,
  type PosCheckout,
  type PosMembership,
  type PosPlan,
  type PosSales,
} from '../lib/pos-types';
import { nextDate } from '../lib/domain';
import { api } from './api';
import { newRequestId } from './browser';
import { Badge, Empty, Field, Form, Skeleton } from './ui';
import './styles/pos.css';

function lastDay(value: string) {
  const date = new Date(value + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
const money = (cents: number) =>
  new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(cents / 100);
/** "2026-11-04" → "4 nov 2026". Dates are calendar days, so they never shift with the time zone. */
const day = (value: string) =>
  new Intl.DateTimeFormat('es-BO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'));
function state(membership: PosMembership, today: string) {
  if (membership.status === 'void') return 'Anulado';
  if (membership.start_date > today) return 'Próximo';
  if (membership.unit === 'sessions') return membership.sessions_remaining ? 'Disponible' : 'Agotado';
  return membership.end_date && today >= membership.end_date ? 'Vencido' : 'Vigente';
}
export default function PersonMemberships({
  personId,
  today,
  compact = false,
  proposed = [],
  canSell = false,
  gated = true,
}: {
  personId: string;
  today: string;
  compact?: boolean;
  proposed?: { start: string; end: string | null }[];
  /** Muestra el formulario para comprar otro plan sin salir de la ficha. */
  canSell?: boolean;
  /** `false` para el personal, cuyo acceso no depende de los planes que tenga. */
  gated?: boolean;
}) {
  const [result, setResult] = useState<MembershipSummary | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event?: Event) => {
      const topics = (event as CustomEvent | undefined)?.detail?.topics as string[] | undefined;
      if (!topics || topics.some((topic) => ['people', 'pos', 'access', 'settings', 'time'].includes(topic)))
        setRevision((value) => value + 1);
    };
    window.addEventListener('data-reloaded', refresh);
    return () => window.removeEventListener('data-reloaded', refresh);
  }, []);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setResult(null);
    setError('');
    void api<MembershipSummary>('pos/memberships/' + encodeURIComponent(personId), 'GET', undefined, controller.signal)
      .then((value) => {
        if (live) setResult(value);
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [personId, revision]);
  if (error)
    return (
      <div className="error-message" role="alert">
        {error}{' '}
        <button className="btn secondary" onClick={() => setRevision((value) => value + 1)}>
          Reintentar
        </button>
      </div>
    );
  if (!result)
    return (
      <>
        <p role="status" className="helper">
          Consultando planes y sesiones…
        </p>
        <Skeleton />
      </>
    );
  const overlap = result.memberships.some(
    (membership) =>
      membership.status === 'active' &&
      membership.end_date &&
      proposed.some(
        (period) => period.end && membership.start_date < period.end && membership.end_date! > period.start,
      ),
  );
  return (
    <section className="person-memberships" aria-label="Planes y sesiones del socio">
      <h3>Planes y sesiones</h3>
      {overlap && (
        <p role="alert" className="error-message">
          La fecha elegida coincide con un plan vigente. La renovación se programará al terminar ese plan para conservar
          los días restantes.
        </p>
      )}
      {result.legacy ? (
        <p className="helper">
          <strong>Acceso heredado.</strong> Este socio todavía utiliza el vencimiento de su ficha:{' '}
          {result.legacy_expires || 'sin fecha de vencimiento'}.{' '}
          {result.legacy_expires
            ? 'Al renovar por adelantado, conserva esta vigencia y el plan nuevo empieza después.'
            : 'Al comprar un plan, el acceso dependerá de sus planes vigentes o sesiones disponibles.'}
        </p>
      ) : (
        <p className="membership-status">
          <Badge tone={result.valid ? 'green' : 'amber'}>
            {result.valid ? 'Con plan vigente' : 'Sin plan vigente ni sesiones disponibles'}
          </Badge>
          {result.memberships.some((item) => item.unit === 'sessions') && (
            <span>{result.sessions_remaining} sesiones disponibles</span>
          )}
        </p>
      )}
      {!gated && result.managed && (
        <p className="helper">
          El acceso del personal se rige por su ficha y su horario: estos planes quedan registrados para los cobros,
          pero no abren ni cierran la puerta.
        </p>
      )}
      {!result.memberships.length ? (
        <Empty title="Sin planes comprados" text="Las compras de planes aparecerán aquí con su vigencia y sesiones." />
      ) : (
        <ul className="pos-membership-list">
          {result.memberships.map((membership) => {
            const label = state(membership, today);
            return (
              <li key={membership.id}>
                <div className="membership-head">
                  <strong>{membership.name}</strong>
                  <Badge tone={label === 'Vigente' || label === 'Disponible' ? 'green' : 'gray'}>{label}</Badge>
                </div>
                <p className="membership-dates">
                  {membership.unit === 'sessions'
                    ? `${membership.sessions_remaining} de ${membership.sessions_total} sesiones · desde el ${day(membership.start_date)}`
                    : membership.end_date
                      ? `Del ${day(membership.start_date)} al ${day(lastDay(membership.end_date))}`
                      : `Desde el ${day(membership.start_date)}, sin vencimiento`}
                </p>
                {!compact && (
                  <p className="membership-meta">
                    <span>{money(membership.price_cents)}</span>
                    <a className="text-link" href={'#pos?sale=' + encodeURIComponent(membership.sale_id)}>
                      Ver comprobante
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canSell && !compact && (
        <div className="membership-actions">
          <AddPlan personId={personId} today={today} onDone={() => setRevision((value) => value + 1)} />
        </div>
      )}
      {!compact && <PersonPayments personId={personId} revision={revision} />}
    </section>
  );
}

/**
 * Compra de un plan más para alguien que ya está en el directorio. Reutiliza el checkout
 * del punto de venta, así que el cobro y el comprobante quedan registrados igual que en caja.
 */
export function AddPlan({ personId, today, onDone }: { personId: string; today: string; onDone: () => void }) {
  const [open, setOpen] = useState(false),
    [plans, setPlans] = useState<PosPlan[] | null>(null),
    [planId, setPlanId] = useState(''),
    [start, setStart] = useState(today),
    [gate, setGate] = useState<PlanGate | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setGate(null);
    void Promise.all([
      api<PosCatalog>('pos/catalog', 'GET', undefined, controller.signal),
      api<MembershipSummary>('pos/memberships/' + encodeURIComponent(personId), 'GET', undefined, controller.signal),
    ])
      .then(([catalog, summary]) => {
        if (controller.signal.aborted) return;
        setPlans(catalog.plans.filter((plan) => plan.active));
        setGate(summary.plan_gate);
        setStart(summary.plan_gate.state === 'renewal' ? summary.plan_gate.start_date : today);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, personId, today]);
  const plan = plans?.find((item) => item.id === planId);
  const end = plan && start ? planEndDate(start, plan.unit, plan.duration) : null;
  if (!open)
    return (
      <button className="btn secondary" onClick={() => setOpen(true)}>
        <Plus size={16} /> Añadir otro plan
      </button>
    );
  return (
    <section aria-label="Añadir un plan">
      <h3>Añadir otro plan</h3>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <Form
        label="Registrar plan y cobro"
        submitDisabled={!plan || loading || !gate || gate.state === 'blocked'}
        onCancel={() => setOpen(false)}
        onSubmit={async (form) => {
          if (!plan) throw Error('Elige un plan disponible.');
          if (loading || !gate) throw Error('Espera a que se consulte la vigencia actual.');
          if (gate.state === 'blocked') throw Error(gate.message);
          const checkout: PosCheckout = {
            request_id: newRequestId(),
            person_id: personId,
            start_date: start,
            payment_method: form.get('payment_method') as PosCheckout['payment_method'],
            expected_total_cents: plan.price_cents,
            lines: [
              {
                kind: 'plan',
                id: plan.id,
                quantity: 1,
                expected_plan: { unit: plan.unit, duration: plan.duration },
              },
            ],
          };
          await api('pos/checkout', 'POST', checkout);
          setOpen(false);
          setPlanId('');
          onDone();
        }}
      >
        <div className="form-grid">
          <Field label="Plan" hint="Los planes se administran en Caja y planes > Planes.">
            <select value={planId} disabled={!plans} onChange={(event) => setPlanId(event.target.value)}>
              <option value="">{plans ? 'Elige un plan' : 'Cargando planes…'}</option>
              {plans?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.duration}{' '}
                  {item.unit === 'days' ? 'día(s)' : item.unit === 'months' ? 'mes(es)' : 'sesión(es)'} ·{' '}
                  {new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(
                    item.price_cents / 100,
                  )}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Inicio del plan">
            <input
              type="date"
              value={start}
              required
              readOnly={gate?.state === 'renewal'}
              min={gate?.state === 'renewal' ? gate.start_date : today}
              onChange={(event) => setStart(event.target.value)}
            />
          </Field>
          <Field label="Pago recibido">
            <select name="payment_method" defaultValue="cash">
              <option value="cash">Efectivo</option>
              <option value="transfer">Transferencia</option>
              <option value="card">Tarjeta</option>
            </select>
          </Field>
        </div>
        {loading && (
          <p className="helper" role="status">
            Consultando la vigencia actual…
          </p>
        )}
        {gate?.state === 'blocked' && (
          <p className="error-message" role="alert">
            {gate.message}
          </p>
        )}
        {gate?.state === 'renewal' && (
          <div className="pos-validity" role="status">
            <strong>Renovación anticipada · conserva sus días restantes</strong>
            <p>{gate.message}</p>
          </div>
        )}
        {plans?.length === 0 && (
          <p className="helper">Todavía no hay planes activos. Créalos en Punto de venta, en la pestaña Planes.</p>
        )}
        {plan && (
          <p className="helper" aria-live="polite">
            {plan.unit === 'sessions'
              ? `${plan.duration} sesiones desde ${start}, sin vencimiento por fecha.`
              : `Válido del ${start} al ${nextDate(end!, -1)}, inclusive.`}{' '}
            El cobro queda registrado hoy. El nuevo plan empieza en la fecha indicada sin cortar el plan vigente.
          </p>
        )}
      </Form>
    </section>
  );
}

export function PersonPayments({ personId, revision }: { personId: string; revision: number }) {
  const [result, setResult] = useState<PosSales | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setResult(null);
    setError('');
    void api<PosSales>(
      'pos/sales?' + new URLSearchParams({ person: personId, page: String(page) }),
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (live) setResult(value);
      })
      .catch((reason) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [personId, page, revision, retry]);
  return (
    <section aria-label="Historial de cobros del socio">
      <h3>Historial de cobros</h3>
      {error ? (
        <p className="error-message" role="alert">
          {error}{' '}
          <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>
            Reintentar cobros
          </button>
        </p>
      ) : !result ? (
        <p className="helper" role="status">
          Consultando cobros…
        </p>
      ) : !result.rows.length ? (
        <p className="helper">Todavía no hay cobros asociados a este socio.</p>
      ) : (
        <>
          <ul className="pos-membership-list">
            {result.rows.map((sale) => (
              <li key={sale.id} className="payment-row">
                <strong>{money(sale.total_cents)}</strong>
                <span>{day(sale.local_date)}</span>
                <Badge tone={sale.status === 'void' ? 'gray' : 'green'}>
                  {sale.status === 'void' ? 'Anulada' : 'Pagada'}
                </Badge>
                <a className="text-link" href={'#pos?sale=' + encodeURIComponent(sale.id)}>
                  Ver comprobante
                </a>
              </li>
            ))}
          </ul>
          {result.total > 50 && (
            <div className="pagination">
              <button className="btn secondary" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
                Anteriores
              </button>
              <span>Página {page}</span>
              <button
                className="btn secondary"
                disabled={page * 50 >= result.total}
                onClick={() => setPage((value) => value + 1)}
              >
                Siguientes
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
