import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Minus, Trash2, Printer, Pencil, Package, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import type { Bootstrap, PersonSummary } from '../lib/domain';
import {
  planEndDate,
  type PosCatalog,
  type PosCheckout,
  type PlanGate,
  type MembershipSummary,
  type PosPlan,
  type PosProduct,
  type PosSaleDetail,
  type PosSales,
  type PaymentMethod,
} from '../lib/pos-types';
import { api, NetworkError, HttpError } from './api';
import { usePeople } from './usePeople';
import { newRequestId } from './browser';
import PersonMemberships from './PersonMemberships';
import PosReports from './PosReports';
import ShareCredentialButton from './ShareCredentialButton';
import { Badge, Empty, Field, Form, Modal, RecordList, Skeleton, type Notify } from './ui';
import './styles/pos.css';

const money = (cents: number) =>
  new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(cents / 100);
const methods: Record<PaymentMethod, string> = { cash: 'Efectivo', transfer: 'Transferencia o QR', card: 'Tarjeta' };
const duration = (plan: PosPlan) =>
  `${plan.duration} ${plan.unit === 'days' ? 'día(s)' : plan.unit === 'months' ? 'mes(es)' : 'sesión(es)'}`;
export function lastValidDate(exclusive: string) {
  const value = new Date(exclusive + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}
const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'No se pudo completar la solicitud.';
type CartLine = { kind: 'product' | 'plan'; id: string; quantity: number };
type PendingCheckout = { payload: PosCheckout; person: PersonSummary | null; catalog: PosCatalog };

export function Checkout({
  data,
  catalog,
  onSold,
  onRefresh,
}: {
  data: Bootstrap;
  catalog: PosCatalog;
  onSold: (sale: PosSaleDetail) => void;
  onRefresh?: () => Promise<void>;
}) {
  const storageKey = `gympass-pos-pending:${data.installation_id}:${data.platform?.gym_id || 'local'}:${data.user.id}`;
  const [recovered] = useState<PendingCheckout | null>(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as PendingCheckout | null;
      return stored?.payload?.request_id &&
        Array.isArray(stored.payload.lines) &&
        stored.catalog?.products &&
        stored.catalog?.plans
        ? stored
        : null;
    } catch {
      return null;
    }
  });
  const [cart, setCart] = useState<CartLine[]>(recovered?.payload.lines || []),
    [search, setSearch] = useState(''),
    [personQuery, setPersonQuery] = useState(''),
    [personPage, setPersonPage] = useState(1),
    [person, setPerson] = useState<PersonSummary | null>(recovered?.person || null),
    [newMember, setNewMember] = useState<PosCheckout['new_member']>(recovered?.payload.new_member),
    [registerOpen, setRegisterOpen] = useState(false),
    [start, setStart] = useState(recovered?.payload.start_date || data.today),
    [method, setMethod] = useState<PaymentMethod>(recovered?.payload.payment_method || 'cash'),
    [uncertain, setUncertain] = useState(!!recovered),
    [submitting, setSubmitting] = useState(false),
    [reviewRequired, setReviewRequired] = useState(false),
    [refreshError, setRefreshError] = useState(''),
    [gate, setGate] = useState<PlanGate | null>(null),
    [replace, setReplace] = useState({ on: false, reason: '' });
  const pending = useRef<PosCheckout | null>(recovered?.payload || null);
  const snapshot = useRef<PosCatalog | null>(recovered?.catalog || null);
  function clearPending() {
    pending.current = null;
    snapshot.current = null;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Navigation remains protected while storage is unavailable. */
    }
  }
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!uncertain && !submitting) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uncertain, submitting]);
  const people = usePeople({ q: personQuery, kind: 'member', page: personPage, limit: 20 });
  const hasPlan = cart.some((line) => line.kind === 'plan');
  useEffect(() => {
    if (hasPlan) return;
    setNewMember(undefined);
    setRegisterOpen(false);
  }, [hasPlan]);
  const personId = person?.id;
  const canReplace = data.user.role === 'admin';
  const autoStart = useRef(false);
  useEffect(() => {
    setGate(null);
    setReplace({ on: false, reason: '' });
    // La fecha puesta automáticamente por una renovación no debe quedar para el siguiente cobro.
    if (autoStart.current) {
      autoStart.current = false;
      setStart(data.today);
    }
    if (!personId || !hasPlan || uncertain) return;
    const controller = new AbortController();
    api<MembershipSummary>('pos/memberships/' + encodeURIComponent(personId), 'GET', undefined, controller.signal)
      .then((summary) => {
        if (controller.signal.aborted || !summary?.plan_gate) return;
        setGate(summary.plan_gate);
        // Si el plan actual vence después de hoy, el nuevo empieza cuando termine.
        if (summary.plan_gate.state === 'renewal') {
          autoStart.current = true;
          setStart(summary.plan_gate.start_date);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [personId, hasPlan]);
  const blocked = gate?.state === 'blocked' && !replace.on;
  const replaceInvalid = replace.on && replace.reason.trim().length < 3;
  const currentCatalog = uncertain && snapshot.current ? snapshot.current : catalog;
  const itemFor = (line: CartLine) =>
    (line.kind === 'product' ? currentCatalog.products : currentCatalog.plans).find((item) => item.id === line.id)!;
  const total = cart.reduce((sum, line) => sum + itemFor(line).price_cents * line.quantity, 0);
  const locked = uncertain || submitting;
  const resolvedDocument = useRef('');
  useEffect(() => {
    const document = personQuery.trim();
    if (locked || newMember || !document || people.busy || people.error || resolvedDocument.current === document)
      return;
    resolvedDocument.current = document;
    const exact = people.rows.filter((row) => row.document.toLowerCase() === document.toLowerCase());
    if (exact.length === 1 && exact[0].status === 'active') setPerson(exact[0]);
  }, [personQuery, people.rows, people.busy, people.error, locked, newMember]);
  function change(kind: CartLine['kind'], id: string, delta: number) {
    if (locked) return;
    setCart((current) => {
      // Un socio solo puede tener un plan: elegir otro lo reemplaza en el cobro, siempre de a uno.
      if (kind === 'plan' && delta > 0)
        return [...current.filter((line) => line.kind !== 'plan'), { kind, id, quantity: 1 }];
      const existing = current.find((line) => line.id === id && line.kind === kind);
      if (!existing) return delta > 0 ? [...current, { kind, id, quantity: 1 }] : current;
      return current
        .map((line) => (line === existing ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0);
    });
  }
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const products = catalog.products.filter(
    (item) => item.active && matches(item.name + ' ' + item.sku + ' ' + item.category),
  );
  const plans = catalog.plans.filter((item) => item.active && matches(item.name));
  return (
    <div className="pos-checkout" data-payment-pending={submitting || uncertain ? 'true' : undefined}>
      <section className="panel pos-selection" aria-label="Catálogo para venta">
        <Field label="Buscar lo que vas a cobrar">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Escribe un nombre, por ejemplo «Mensual»"
          />
        </Field>
        {!products.length && !plans.length && (
          <Empty
            title={search ? 'No encontramos nada con ese nombre' : 'Aún no hay nada para vender'}
            text={
              search
                ? 'Prueba con otra palabra o borra la búsqueda.'
                : 'Crea tu primer plan o producto en las pestañas «Planes» y «Productos».'
            }
          />
        )}
        <div className="pos-catalog-items">
          {!!products.length && (
            <section className="pos-catalog-group">
              <h2>Productos</h2>
              <div className="pos-items" tabIndex={0} aria-label="Productos disponibles">
                {products.map((product) => (
                  <button
                    key={product.id}
                    className="pos-item"
                    disabled={
                      locked ||
                      (!!product.track_stock &&
                        product.stock <=
                          (cart.find((line) => line.kind === 'product' && line.id === product.id)?.quantity || 0))
                    }
                    onClick={() => change('product', product.id, 1)}
                  >
                    <strong>{product.name}</strong>
                    <span>{money(product.price_cents)}</span>
                    <small>{product.track_stock ? `${product.stock} en stock` : 'Sin control de stock'}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!!plans.length && (
            <section className="pos-catalog-group">
              <h2>Planes</h2>
              <div className="pos-items" tabIndex={0} aria-label="Planes disponibles">
                {plans.map((plan) => (
                  <button
                    key={plan.id}
                    className="pos-item"
                    disabled={locked}
                    onClick={() => change('plan', plan.id, 1)}
                  >
                    <strong>{plan.name}</strong>
                    <span>{money(plan.price_cents)}</span>
                    <small>{duration(plan)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>
      <section className="panel pos-cart" aria-label="Nueva venta">
        <h2>Cobro</h2>
        <Form
          unsaved={cart.length > 0 || uncertain}
          label={uncertain ? 'Reintentar confirmación' : `Confirmar cobro · ${money(total)}`}
          submitDisabled={
            !cart.length ||
            reviewRequired ||
            (!pending.current && hasPlan && !newMember && (!person || person.status !== 'active')) ||
            (!pending.current && (blocked || replaceInvalid))
          }
          onSubmit={async () => {
            if (submittingRef.current) return;
            if (!cart.length) throw Error('Añade al menos un producto o plan.');
            if (!pending.current && hasPlan && !newMember && (!person || person.status !== 'active'))
              throw Error('Selecciona un socio activo para vender planes.');
            if (!pending.current && gate?.state === 'blocked' && !replace.on) throw Error(gate.message);
            const retrying = !!pending.current;
            if (!pending.current)
              pending.current = {
                request_id: newRequestId(),
                ...(hasPlan && newMember ? { new_member: newMember } : person ? { person_id: person.id } : {}),
                ...(hasPlan && newMember ? {} : { start_date: start }),
                ...(replace.on && canReplace && gate?.state !== 'free' && hasPlan
                  ? { replace_active: { reason: replace.reason.trim() } }
                  : {}),
                payment_method: method,
                expected_total_cents: total,
                lines: cart.map((line) => ({
                  ...line,
                  ...(line.kind === 'plan'
                    ? {
                        expected_plan: {
                          unit: (itemFor(line) as PosPlan).unit,
                          duration: (itemFor(line) as PosPlan).duration,
                        },
                      }
                    : {}),
                })),
              };
            snapshot.current = currentCatalog;
            try {
              const cartCatalog = {
                products: currentCatalog.products.filter((item) =>
                  cart.some((line) => line.kind === 'product' && line.id === item.id),
                ),
                plans: currentCatalog.plans.filter((item) =>
                  cart.some((line) => line.kind === 'plan' && line.id === item.id),
                ),
              };
              sessionStorage.setItem(
                storageKey,
                JSON.stringify({ payload: pending.current, person, catalog: cartCatalog }),
              );
            } catch {
              if (!retrying) {
                pending.current = null;
                snapshot.current = null;
                throw Error(
                  'Habilita el almacenamiento de este sitio para conservar y recuperar los cobros pendientes.',
                );
              }
            }
            submittingRef.current = true;
            setSubmitting(true);
            try {
              const sale = await api<PosSaleDetail>('pos/checkout', 'POST', pending.current);
              clearPending();
              setUncertain(false);
              setCart([]);
              setNewMember(undefined);
              setPerson(null);
              setPersonQuery('');
              setStart(data.today);
              onSold(sale);
            } catch (reason) {
              if (
                reason instanceof NetworkError ||
                (reason instanceof HttpError && (reason.status >= 500 || [401, 403].includes(reason.status)))
              )
                setUncertain(true);
              else {
                clearPending();
                setUncertain(false);
                if (reason instanceof HttpError && reason.status === 409) setReviewRequired(true);
              }
              throw reason;
            } finally {
              submittingRef.current = false;
              setSubmitting(false);
            }
          }}
        >
          <fieldset disabled={locked} className="pos-fields">
            {!cart.length ? (
              <p className="helper">Toca un producto o plan de la izquierda para agregarlo al cobro.</p>
            ) : (
              <ul className="pos-cart-lines">
                {cart.map((line) => {
                  const item = itemFor(line);
                  const product = line.kind === 'product' ? (item as PosProduct) : null;
                  return (
                    <li key={line.kind + line.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{money(item.price_cents)} por unidad</small>
                      </div>
                      <div className="pos-quantity">
                        {product && (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={'Quitar una unidad de ' + item.name}
                              onClick={() => change(line.kind, line.id, -1)}
                            >
                              <Minus size={16} />
                            </button>
                            <span aria-label="Cantidad">{line.quantity}</span>
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={'Añadir una unidad de ' + item.name}
                              disabled={!!product.track_stock && line.quantity >= product.stock}
                              onClick={() => change(line.kind, line.id, 1)}
                            >
                              <Plus size={16} />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={'Eliminar ' + item.name}
                          onClick={() => setCart((current) => current.filter((row) => row !== line))}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <strong>{money(item.price_cents * line.quantity)}</strong>
                    </li>
                  );
                })}
              </ul>
            )}
            {hasPlan && newMember && (
              <div className="pos-validity" role="status">
                <strong>{newMember.name}</strong> · {newMember.document}
                <p>WhatsApp: +{newMember.phone}</p>
                <p className="helper">El socio se registrará al confirmar este cobro.</p>
                <button type="button" className="btn secondary small" onClick={() => setRegisterOpen(true)}>
                  Editar datos del nuevo socio
                </button>
                <button type="button" className="btn secondary small" onClick={() => setNewMember(undefined)}>
                  Elegir un socio existente
                </button>
              </div>
            )}
            {!newMember && (
              <>
                <Field
                  label={hasPlan ? 'Socio (obligatorio para vender un plan)' : 'Socio (opcional)'}
                  hint="El documento completo selecciona al socio automáticamente. También puedes buscar por nombre."
                >
                  <input
                    type="search"
                    value={personQuery}
                    maxLength={120}
                    onChange={(event) => {
                      resolvedDocument.current = '';
                      setPerson(null);
                      setPersonQuery(event.target.value);
                      setPersonPage(1);
                    }}
                  />
                </Field>
                {person && (
                  <Field label="Nombre del socio">
                    <input value={person.name} readOnly />
                  </Field>
                )}
                {(!!personQuery.trim() || !!person || hasPlan) && (
                  <Field label="Elige al socio">
                    <select
                      value={person?.id || ''}
                      required={hasPlan}
                      onChange={(event) => setPerson(people.rows.find((row) => row.id === event.target.value) || null)}
                    >
                      <option value="">Venta sin socio</option>
                      {person && !people.rows.some((row) => row.id === person.id) && (
                        <option value={person.id}>
                          {person.name} · {person.document}
                        </option>
                      )}
                      {people.rows.map((row) => (
                        <option value={row.id} key={row.id} disabled={row.status !== 'active'}>
                          {row.name} · {row.document}
                          {row.status !== 'active' ? ' · Suspendido' : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {people.busy && (
                  <p role="status" className="helper">
                    Buscando socios…
                  </p>
                )}
                {people.error && (
                  <p role="alert" className="error-message">
                    {people.error}
                  </p>
                )}
                {!!personQuery.trim() && !people.busy && !people.error && !people.total && (
                  <p className="helper">No hay socios que coincidan con la búsqueda.</p>
                )}
                {hasPlan && !person && !!personQuery.trim() && !people.busy && !people.error && people.total === 0 && (
                  <button type="button" className="btn secondary" onClick={() => setRegisterOpen(true)}>
                    <Plus size={16} /> Crear socio para este cobro
                  </button>
                )}
                {people.total > 20 && (
                  <div className="pagination">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={personPage === 1 || people.busy}
                      onClick={() => setPersonPage((value) => value - 1)}
                    >
                      Anteriores
                    </button>
                    <span>Página {personPage}</span>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={personPage * 20 >= people.total || people.busy}
                      onClick={() => setPersonPage((value) => value + 1)}
                    >
                      Siguientes
                    </button>
                  </div>
                )}
              </>
            )}
            {hasPlan && (
              <>
                {gate?.state === 'blocked' && (
                  <div role="alert" className="error-message">
                    {gate.message}
                    {canReplace && (
                      <label className="pos-replace">
                        <input
                          type="checkbox"
                          checked={replace.on}
                          onChange={(event) => setReplace({ on: event.target.checked, reason: replace.reason })}
                        />
                        Reemplazar el plan actual
                      </label>
                    )}
                  </div>
                )}
                {gate && gate.state !== 'free' && canReplace && replace.on && (
                  <Field
                    label="Motivo del reemplazo"
                    hint="El plan actual se da de baja y el nuevo empieza en la fecha elegida. Queda registrado."
                  >
                    <input
                      value={replace.reason}
                      maxLength={300}
                      onChange={(event) => setReplace({ on: true, reason: event.target.value })}
                      placeholder="Ej. Cambia de Mensual a Anual"
                    />
                  </Field>
                )}
                {gate?.state === 'renewal' && !replace.on && (
                  <div className="pos-validity" role="status">
                    <strong>Renovación anticipada · conserva sus días restantes</strong>
                    <p>{gate.message}</p>
                    {canReplace && (
                      <label className="pos-replace">
                        <input
                          type="checkbox"
                          checked={replace.on}
                          onChange={(event) => setReplace({ on: event.target.checked, reason: replace.reason })}
                        />
                        Cancelar el plan actual y reemplazarlo (pierde los días restantes)
                      </label>
                    )}
                  </div>
                )}
                <Field label="Inicio del plan">
                  <input
                    type="date"
                    required
                    min={gate?.state === 'renewal' && !replace.on ? gate.start_date : data.today}
                    value={newMember ? data.today : start}
                    readOnly={!!newMember || (gate?.state === 'renewal' && !replace.on)}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label="¿Cómo pagó?">
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
                {Object.entries(methods).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {hasPlan && (
              <div className="pos-validity" aria-live="polite">
                {cart
                  .filter((line) => line.kind === 'plan')
                  .map((line) => {
                    const plan = itemFor(line) as PosPlan;
                    const end = start ? planEndDate(start, plan.unit, plan.duration) : null;
                    return (
                      <p key={line.id}>
                        <strong>
                          {plan.name}
                          {line.quantity > 1 ? ` · ${line.quantity} planes` : ''}
                        </strong>
                        <br />
                        {plan.unit === 'sessions'
                          ? `${plan.duration * line.quantity} sesiones desde ${start || 'la fecha elegida'}, sin vencimiento`
                          : start && end
                            ? `Válido del ${start} al ${lastValidDate(end)}, inclusive`
                            : 'Elige una fecha de inicio válida.'}
                      </p>
                    );
                  })}
                <p className="helper">Un socio solo puede tener un plan en curso a la vez.</p>
              </div>
            )}
          </fieldset>
          <p className="helper">Recibe el pago primero y después confirma el cobro. Necesitas conexión a internet.</p>
          {uncertain && (
            <p className="error-message" role="alert">
              No se pudo confirmar la respuesta del servidor. Reintenta esta misma operación para consultar o completar
              el cobro sin duplicarlo.
            </p>
          )}
          {reviewRequired && (
            <div role="alert" className="error-message">
              Revisa los precios y las existencias antes de confirmar de nuevo.
              <button
                type="button"
                className="btn secondary"
                onClick={async () => {
                  try {
                    await onRefresh?.();
                    setReviewRequired(false);
                    setRefreshError('');
                  } catch (reason) {
                    setRefreshError(errorText(reason));
                  }
                }}
              >
                Actualizar catálogo
              </button>
              {refreshError && <p>{refreshError}</p>}
            </div>
          )}
        </Form>
        {person && (
          <details className="pos-member-history">
            <summary>Ver planes y sesiones del socio</summary>
            <PersonMemberships personId={person.id} today={data.today} compact />
          </details>
        )}
      </section>
      {registerOpen &&
        !locked &&
        createPortal(
          <Modal title="Registrar socio para este cobro" onClose={() => setRegisterOpen(false)}>
            <p>Completa los datos del socio para continuar con el plan seleccionado.</p>
            <Form
              label="Continuar con el cobro"
              onCancel={() => setRegisterOpen(false)}
              onSubmit={async (form) => {
                const phone = String(form.get('phone') || '').replace(/\D/g, '');
                if (!/^[1-9]\d{8,14}$/.test(phone)) throw Error('Registra el WhatsApp con código de país.');
                const name = String(form.get('name') || '').trim();
                const document = String(form.get('document') || '').trim();
                if (!name || !document) throw Error('Completa el nombre y el documento del socio.');
                setNewMember({ name, document, phone, kind: 'member', status: 'active' });
                setPerson(null);
                setStart(data.today);
                setRegisterOpen(false);
              }}
            >
              <Field label="Nombre completo">
                <input name="name" required maxLength={120} defaultValue={newMember?.name || ''} autoComplete="name" />
              </Field>
              <Field label="Documento de identidad">
                <input name="document" required maxLength={120} defaultValue={newMember?.document || ''} />
              </Field>
              <Field label="WhatsApp" hint="Incluye el código de país, por ejemplo 59171234567.">
                <input
                  name="phone"
                  type="tel"
                  required
                  maxLength={24}
                  autoComplete="tel"
                  defaultValue={newMember?.phone || ''}
                />
              </Field>
            </Form>
          </Modal>,
          document.body,
        )}
    </div>
  );
}

function CatalogEditor({
  kind,
  item,
  onClose,
  onSaved,
}: {
  kind: 'product' | 'plan';
  item?: PosProduct | PosPlan;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const savedId = useRef(item?.id);
  const product = kind === 'product' ? (item as PosProduct | undefined) : undefined;
  const plan = kind === 'plan' ? (item as PosPlan | undefined) : undefined;
  return (
    <Modal title={`${item ? 'Editar' : 'Nuevo'} ${kind === 'product' ? 'producto' : 'plan'}`} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async (form) => {
          const price = String(form.get('price')).trim();
          if (!/^\d+(?:[.,]\d{1,2})?$/.test(price)) throw Error('Indica un precio válido con hasta dos decimales.');
          const priceCents = Math.round(Number(price.replace(',', '.')) * 100);
          if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw Error('El precio no es válido.');
          const result = await api<{ id: string }>(
            `pos/${kind === 'product' ? 'products' : 'plans'}${savedId.current ? '/' + encodeURIComponent(savedId.current) : ''}`,
            savedId.current ? 'PATCH' : 'POST',
            {
              name: String(form.get('name')).trim(),
              price_cents: priceCents,
              active: form.get('active') === '1' ? 1 : 0,
              ...(kind === 'product'
                ? {
                    sku: String(form.get('sku') || '').trim(),
                    category: String(form.get('category') || '').trim(),
                    track_stock: form.get('track_stock') === '1' ? 1 : 0,
                    ...(!item ? { stock: Number(form.get('stock') || 0) } : {}),
                  }
                : { unit: form.get('unit'), duration: Number(form.get('duration')) }),
            },
          );
          savedId.current = result.id;
          await onSaved();
          onClose();
        }}
      >
        <Field label="Nombre">
          <input name="name" required maxLength={120} defaultValue={item?.name} />
        </Field>
        <Field label="Precio de venta (BOB)">
          <input
            name="price"
            required
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            defaultValue={((item?.price_cents || 0) / 100).toFixed(2)}
          />
        </Field>
        {kind === 'product' ? (
          <>
            <div className="form-grid">
              <Field label="Código / SKU">
                <input name="sku" maxLength={80} defaultValue={product?.sku} />
              </Field>
              <Field label="Categoría">
                <input name="category" maxLength={80} defaultValue={product?.category} />
              </Field>
            </div>
            <Field label="Inventario">
              <select name="track_stock" defaultValue={product?.track_stock ?? 1}>
                <option value="1">Controlar stock</option>
                <option value="0">Sin control de stock</option>
              </select>
            </Field>
            {!item && (
              <Field label="Stock inicial">
                <input type="number" name="stock" min="0" step="1" required defaultValue="0" />
              </Field>
            )}
            {item && (
              <p className="helper">
                Existencias: {product?.stock}. Utiliza Ajustar stock para registrar cambios y su motivo.
              </p>
            )}
          </>
        ) : (
          <div className="form-grid">
            <Field label="Modalidad">
              <select name="unit" defaultValue={plan?.unit || 'months'}>
                <option value="days">Días</option>
                <option value="months">Meses</option>
                <option value="sessions">Sesiones</option>
              </select>
            </Field>
            <Field label="Duración / cantidad" hint="Un año equivale a 12 meses.">
              <input
                name="duration"
                type="number"
                required
                min="1"
                step="1"
                max="1200"
                defaultValue={plan?.duration || 1}
              />
            </Field>
          </div>
        )}
        <Field label="Estado">
          <select name="active" defaultValue={item?.active ?? 1}>
            <option value="1">Activo</option>
            <option value="0">Inactivo</option>
          </select>
        </Field>
        <p className="helper">Desactivar impide nuevas ventas y conserva el historial.</p>
      </Form>
    </Modal>
  );
}

function StockEditor({
  product,
  onClose,
  onSaved,
}: {
  product: PosProduct;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Modal title={'Ajustar stock · ' + product.name} onClose={onClose}>
      <p>
        Existencias actuales: <strong>{product.stock}</strong>
      </p>
      <Form
        label="Registrar ajuste"
        onCancel={onClose}
        onSubmit={async (form) => {
          await api('pos/products/' + encodeURIComponent(product.id) + '/stock', 'POST', {
            quantity: Number(form.get('quantity')),
            reason: String(form.get('reason')).trim(),
          });
          await onSaved();
          onClose();
        }}
      >
        <Field label="Cantidad a sumar o restar" hint="Ejemplo: 10 para reponer, -2 para retirar.">
          <input name="quantity" type="number" step="1" required />
        </Field>
        <Field label="Motivo">
          <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
        </Field>
      </Form>
    </Modal>
  );
}

export function SaleReceipt({
  sale,
  data,
  canVoid,
  onClose,
  onVoided,
}: {
  sale: PosSaleDetail;
  data: Bootstrap;
  canVoid: boolean;
  onClose: () => void;
  onVoided: (sale: PosSaleDetail) => void;
}) {
  const [voiding, setVoiding] = useState(false);
  return (
    <Modal title="Detalle de venta" wide onClose={onClose} className="pos-sale-modal">
      <div className="pos-receipt">
        <header>
          <h2>{data.settings.name}</h2>
          <p>Comprobante de venta · No es factura fiscal</p>
          <strong>{sale.id}</strong>
        </header>
        <dl className="pos-sale-data">
          <dt>Fecha</dt>
          <dd>
            {sale.local_date} ·{' '}
            {new Intl.DateTimeFormat('es-BO', {
              timeZone: data.settings.timezone,
              hour: '2-digit',
              minute: '2-digit',
            }).format(sale.created_at)}
          </dd>
          <dt>Socio</dt>
          <dd>{sale.person_name || 'Venta sin socio'}</dd>
          <dt>Responsable</dt>
          <dd>{sale.actor}</dd>
          <dt>Pago</dt>
          <dd>{methods[sale.payment_method]}</dd>
          <dt>Estado</dt>
          <dd>{sale.status === 'void' ? 'Anulada' : 'Pagada'}</dd>
        </dl>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Concepto</th>
                <th>Cantidad</th>
                <th>Precio</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.name}</td>
                  <td>{line.quantity}</td>
                  <td>{money(line.price_cents)}</td>
                  <td>{money(line.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pos-total">
          Total <strong>{money(sale.total_cents)}</strong>
        </p>
        {sale.replace_reason && <p className="helper">Reemplazó el plan anterior: {sale.replace_reason}</p>}
        {sale.credential && sale.status === 'paid' && (
          <div className="helper">
            <p>
              El socio conserva su mismo QR. El acceso se valida con las fechas de inicio y fin de sus planes; no
              necesita otra tarjeta al renovar.
            </p>
            {data.user.role !== 'viewer' && !!sale.credential.active && (
              <ShareCredentialButton
                id={sale.credential.id}
                name={sale.person_name || 'Socio'}
                phone={sale.credential.phone}
                settings={data.settings}
                notify={() => {}}
              />
            )}
          </div>
        )}
        {sale.memberships.map((membership) => (
          <p key={membership.id}>
            {membership.name} ·{' '}
            {membership.unit === 'sessions'
              ? `${membership.sessions_total} sesiones desde ${membership.start_date}`
              : `${membership.start_date} al ${membership.end_date ? lastValidDate(membership.end_date) : 'sin vencimiento'}`}
          </p>
        ))}
        {sale.warnings.map((warning, index) => (
          <p className="helper" key={index}>
            {warning}
          </p>
        ))}
        {sale.status === 'void' && (
          <p>
            Anulada: {sale.void_reason} · {sale.void_by}
          </p>
        )}
      </div>
      <div className="button-row pos-receipt-actions">
        <button className="btn secondary" onClick={() => window.print()}>
          <Printer size={17} /> Imprimir comprobante
        </button>
        {canVoid && sale.status === 'paid' && (
          <button className="btn secondary" onClick={() => setVoiding((value) => !value)}>
            <RotateCcw size={17} /> Anular venta
          </button>
        )}
      </div>
      {voiding && (
        <Form
          label="Confirmar anulación"
          onCancel={() => setVoiding(false)}
          onSubmit={async (form) => {
            const result = await api<PosSaleDetail>('pos/sales/' + encodeURIComponent(sale.id) + '/void', 'POST', {
              reason: String(form.get('reason')).trim(),
            });
            onVoided(result);
            setVoiding(false);
          }}
        >
          <p className="helper">
            Se repone el stock una sola vez. Solo se anulan planes que todavía no comenzaron ni consumieron sesiones.
          </p>
          <Field label="Motivo de anulación">
            <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
          </Field>
        </Form>
      )}
    </Modal>
  );
}

function SalesHistory({ data, revision, onOpen }: { data: Bootstrap; revision: number; onOpen: (id: string) => void }) {
  const [from, setFrom] = useState(data.today.slice(0, 8) + '01'),
    [to, setTo] = useState(data.today),
    [page, setPage] = useState(1),
    [result, setResult] = useState<PosSales | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setResult(null);
    if (!from || !to || from > to) {
      setError('Indica un período válido.');
      setBusy(false);
      return;
    }
    void api<PosSales>(
      'pos/sales?' + new URLSearchParams({ from, to, page: String(page) }),
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (live) setResult(value);
      })
      .catch((reason) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [from, to, page, revision, retry]);
  return (
    <section className="panel">
      <div className="pos-history-filters">
        <Field label="Desde">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Hasta">
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>
          Actualizar
        </button>
      </div>
      {result && (
        <div className="pos-sales-summary">
          <strong>Ventas pagadas: {money(result.total_cents)}</strong>
          {result.by_method.map((row) => (
            <span key={row.payment_method}>
              {methods[row.payment_method]}: {money(row.total_cents)} · {row.count} ventas
            </span>
          ))}
        </div>
      )}
      <RecordList
        rows={result?.rows || []}
        getKey={(row) => row.id}
        state={{ status: busy ? 'loading' : error ? 'error' : 'ready', error }}
        emptyText="No hay ventas en este período."
        headers={
          <tr>
            <th>Fecha / venta</th>
            <th>Socio</th>
            <th>Pago</th>
            <th className="num">Total</th>
            <th>Estado</th>
            <th>Detalle</th>
          </tr>
        }
        renderDesktopRow={(row) => (
          <>
            <td>
              {row.local_date}
              <small>Venta {row.id.slice(0, 8)}</small>
            </td>
            <td>{row.person_name || 'Sin socio'}</td>
            <td>{methods[row.payment_method]}</td>
            <td className="num">{money(row.total_cents)}</td>
            <td>
              <Badge tone={row.status === 'void' ? 'gray' : 'green'}>
                {row.status === 'void' ? 'Anulada' : 'Pagada'}
              </Badge>
            </td>
            <td>
              <button className="btn secondary small" onClick={() => onOpen(row.id)}>
                Ver venta
              </button>
            </td>
          </>
        )}
        renderMobileItem={(row) => (
          <>
            <header>
              <strong>{money(row.total_cents)}</strong>
              <Badge tone={row.status === 'void' ? 'gray' : 'green'}>
                {row.status === 'void' ? 'Anulada' : 'Pagada'}
              </Badge>
            </header>
            <p>
              {row.local_date} · {row.person_name || 'Sin socio'}
            </p>
            <p>{methods[row.payment_method]}</p>
            <button className="btn secondary" onClick={() => onOpen(row.id)}>
              Ver venta
            </button>
          </>
        )}
      />
      <div className="pagination">
        <span>{busy ? 'Cargando ventas…' : `${result?.total || 0} ventas`}</span>
        <div>
          <button
            className="icon-btn"
            aria-label="Página anterior de ventas"
            disabled={busy || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span>Página {page}</span>
          <button
            className="icon-btn"
            aria-label="Página siguiente de ventas"
            disabled={busy || !result || page * 50 >= result.total}
            onClick={() => setPage((value) => value + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Pos({
  data,
  reload,
  notify,
}: {
  data: Bootstrap;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const canWrite = data.user.role !== 'viewer' && !data.platform?.read_only;
  const admin = data.user.role === 'admin' && canWrite;
  const [tab, setTab] = useState<'checkout' | 'products' | 'plans' | 'sales' | 'reports'>(
      canWrite ? 'checkout' : 'sales',
    ),
    [catalog, setCatalog] = useState<PosCatalog | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [revision, setRevision] = useState(0),
    [editor, setEditor] = useState<{ kind: 'product' | 'plan'; item?: PosProduct | PosPlan } | null>(null),
    [stock, setStock] = useState<PosProduct | null>(null),
    [sale, setSale] = useState<PosSaleDetail | null>(null),
    [opening, setOpening] = useState(false),
    [query, setQuery] = useState('');
  const refreshCatalog = async () => {
    setCatalog(await api<PosCatalog>('pos/catalog'));
  };
  useEffect(() => {
    const refresh = (event?: Event) => {
      const topics = (event as CustomEvent | undefined)?.detail?.topics as string[] | undefined;
      if (!topics || topics.some((topic) => topic === 'pos' || topic === 'settings')) setRevision((value) => value + 1);
    };
    window.addEventListener('data-reloaded', refresh);
    return () => window.removeEventListener('data-reloaded', refresh);
  }, []);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<PosCatalog>('pos/catalog', 'GET', undefined, controller.signal)
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch((reason) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [revision]);
  async function openSale(id: string) {
    setOpening(true);
    try {
      setSale(await api<PosSaleDetail>('pos/sales/' + encodeURIComponent(id)));
    } catch (reason) {
      notify(errorText(reason), true);
    } finally {
      setOpening(false);
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('sale');
    if (id) {
      setTab('sales');
      void openSale(id);
    }
  }, []);
  const saved = async () => {
    setRevision((value) => value + 1);
    notify('Catálogo actualizado');
    await refreshCatalog().catch((reason) => notify('El cambio se guardó. ' + errorText(reason), true));
  };
  return (
    <div className={'pos-page' + (tab === 'reports' ? ' pos-page-flow' : '')}>
      <div className="page-heading">
        <div>
          <h1>Caja y planes</h1>
          <p>Cobra productos y planes a tus socios y consulta lo que ya vendiste.</p>
        </div>
      </div>
      <nav className="pos-tabs" aria-label="Secciones de caja">
        {(
          [
            ...(canWrite ? [['checkout', 'Caja']] : []),
            ['products', 'Productos'],
            ['plans', 'Planes'],
            ['sales', 'Ventas hechas'],
            ...(data.user.role === 'admin' ? [['reports', 'Reportes']] : []),
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={'btn ' + (tab === key ? 'primary' : 'secondary')}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              setTab(key as typeof tab);
              setQuery('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="error-message">
          {error}{' '}
          <button className="btn secondary" onClick={() => setRevision((value) => value + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {catalog && canWrite && (
        <div className="pos-checkout-tab" hidden={tab !== 'checkout'}>
          <Checkout
            data={data}
            catalog={catalog}
            onRefresh={refreshCatalog}
            onSold={(value) => {
              setSale(value);
              setRevision((current) => current + 1);
              notify('Venta registrada');
              void reload().catch((reason) => notify('La venta se guardó. ' + errorText(reason), true));
            }}
          />
        </div>
      )}
      {tab === 'reports' && data.user.role === 'admin' ? (
        <PosReports data={data} notify={notify} />
      ) : tab === 'sales' ? (
        <SalesHistory data={data} revision={revision} onOpen={(id) => void openSale(id)} />
      ) : busy && !catalog ? (
        <Skeleton />
      ) : (
        catalog && (
          <>
            {tab === 'checkout' ? null : (
              <section className="panel pos-catalog-panel">
                <div className="pos-catalog-heading">
                  <Field label={tab === 'products' ? 'Buscar producto' : 'Buscar plan'}>
                    <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
                  </Field>
                  {admin && (
                    <button
                      className="btn primary"
                      onClick={() => setEditor({ kind: tab === 'products' ? 'product' : 'plan' })}
                    >
                      <Plus size={17} />
                      {tab === 'products' ? 'Nuevo producto' : 'Nuevo plan'}
                    </button>
                  )}
                </div>
                <RecordList
                  rows={(tab === 'products' ? catalog.products : catalog.plans).filter((item) =>
                    item.name.toLowerCase().includes(query.toLowerCase()),
                  )}
                  getKey={(item) => item.id}
                  state={{ status: 'ready' }}
                  emptyText={
                    tab === 'products'
                      ? 'Todavía no hay productos en este catálogo.'
                      : 'Todavía no hay planes en este catálogo.'
                  }
                  headers={
                    <tr>
                      <th>Nombre</th>
                      <th>{tab === 'products' ? 'Código / categoría' : 'Modalidad'}</th>
                      <th className="num">Precio</th>
                      <th>Estado / stock</th>
                      {admin && <th>Acciones</th>}
                    </tr>
                  }
                  renderDesktopRow={(item) => (
                    <>
                      <td>
                        <strong>{item.name}</strong>
                      </td>
                      <td>
                        {'sku' in item ? (
                          <>
                            {item.sku || 'Sin código'}
                            <small>{item.category || 'Sin categoría'}</small>
                          </>
                        ) : (
                          duration(item)
                        )}
                      </td>
                      <td className="num">{money(item.price_cents)}</td>
                      <td>
                        <Badge tone={item.active ? 'green' : 'gray'}>{item.active ? 'Activo' : 'Inactivo'}</Badge>
                        {'stock' in item && (
                          <small>{item.track_stock ? item.stock + ' en stock' : 'Sin control de stock'}</small>
                        )}
                      </td>
                      {admin && (
                        <td>
                          <div className="button-row">
                            <button
                              className="btn secondary"
                              onClick={() => setEditor({ kind: tab === 'products' ? 'product' : 'plan', item })}
                            >
                              <Pencil size={16} /> Editar
                            </button>
                            {'stock' in item && !!item.track_stock && (
                              <button className="btn secondary" onClick={() => setStock(item)}>
                                <Package size={16} /> Ajustar stock
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </>
                  )}
                  renderMobileItem={(item) => (
                    <>
                      <header>
                        <strong>{item.name}</strong>
                        <Badge tone={item.active ? 'green' : 'gray'}>{item.active ? 'Activo' : 'Inactivo'}</Badge>
                      </header>
                      <p>
                        {money(item.price_cents)} ·{' '}
                        {'stock' in item
                          ? item.track_stock
                            ? `${item.stock} en stock`
                            : 'Sin control de stock'
                          : duration(item)}
                      </p>
                      {admin && (
                        <div className="button-row">
                          <button
                            className="btn secondary"
                            onClick={() => setEditor({ kind: tab === 'products' ? 'product' : 'plan', item })}
                          >
                            Editar
                          </button>
                          {'stock' in item && !!item.track_stock && (
                            <button className="btn secondary" onClick={() => setStock(item)}>
                              Ajustar stock
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                />
              </section>
            )}
          </>
        )
      )}
      {opening && (
        <p role="status" className="helper">
          Abriendo comprobante…
        </p>
      )}
      {editor && admin && <CatalogEditor {...editor} onClose={() => setEditor(null)} onSaved={saved} />}
      {stock && admin && <StockEditor product={stock} onClose={() => setStock(null)} onSaved={saved} />}
      {sale && (
        <SaleReceipt
          sale={sale}
          data={data}
          canVoid={admin}
          onClose={() => setSale(null)}
          onVoided={(value) => {
            setSale(value);
            setRevision((current) => current + 1);
            notify('Venta anulada');
            void reload().catch((reason) => notify(errorText(reason), true));
          }}
        />
      )}
    </div>
  );
}
