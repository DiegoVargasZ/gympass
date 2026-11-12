import { useEffect, useState, useRef } from 'react';
import {
  Plus,
  Search,
  ScanLine,
  Download,
  Printer,
  Copy,
  KeyRound,
  Ban,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
} from 'lucide-react';
import { api, upload, HttpError } from './api';
import { copyText, newRequestId } from './browser';
import PhotoEditor from './PhotoEditor';
import PersonMemberships from './PersonMemberships';
import { logoUrl } from './branding';
import ScopedImage from './ScopedImage';
import ShareCredentialButton from './ShareCredentialButton';
import { Modal, Form, Field, Avatar, Badge, Empty, Skeleton, RecordList, FilterBar, type Notify } from './ui';
import {
  kindLabels,
  localParts,
  nextDate,
  type Bootstrap,
  type Person,
  type PersonSummary,
  type Credential,
} from '../lib/domain';
import { planEndDate, type PosCatalog, type PosPlan, type PosCheckout, type PosSaleDetail } from '../lib/pos-types';
import { usePeople } from './usePeople';
import { qrSvg } from '../lib/qr';
import type { CardData } from '../lib/card';
/**
 * Dibujar una tarjeta arrastra el logo incrustado (unos 100 KB de la descarga inicial) y solo
 * hace falta al descargar o imprimir una credencial, así que se carga recién en ese momento.
 */
const cardTools = async () => ({
  ...(await import('./card-download')),
  ...(await import('./credential-cards')),
});
type CardTools = Awaited<ReturnType<typeof cardTools>>;
/** Los socios compran planes (y las fichas antiguas de personal); un visitante entra por invitación. */
const planHolder = (kind: string) => kind === 'member' || kind === 'employee';
export function PersonForm({
  data,
  person,
  onDone,
  onClose,
}: {
  data: Bootstrap;
  person?: Person;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [photo, setPhoto] = useState<Blob | null | undefined>(null);
  const [kind, setKind] = useState(person?.kind || 'member'),
    [plans, setPlans] = useState<PosPlan[] | null>(null),
    [planId, setPlanId] = useState(''),
    [planError, setPlanError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [registered, setRegistered] = useState(false);
  const savedId = useRef(person?.id);
  const pending = useRef<PosCheckout | null>(null);
  const selectedPlan = !person && planHolder(kind) ? plans?.find((plan) => plan.id === planId) : undefined;
  const today = person ? data.today : localParts(new Date(), data.settings.timezone).date;
  const end = selectedPlan ? planEndDate(today, selectedPlan.unit, selectedPlan.duration) : null;
  async function loadPlans(signal?: AbortSignal) {
    try {
      const catalog = await api<PosCatalog>('pos/catalog', 'GET', undefined, signal);
      if (signal?.aborted) return;
      setPlans(catalog.plans.filter((plan) => plan.active));
      setPlanError('');
    } catch (error) {
      if (!signal?.aborted) setPlanError((error as Error).message);
    }
  }
  useEffect(() => {
    if (person) return;
    const controller = new AbortController();
    void loadPlans(controller.signal);
    return () => controller.abort();
  }, []);
  function close() {
    if (!pending.current) onClose();
  }
  return (
    <Modal title={person ? 'Editar ficha' : 'Registrar socio'} wide onClose={close}>
      <Form
        onCancel={uncertain ? undefined : close}
        label={
          person
            ? 'Guardar cambios'
            : uncertain
              ? 'Reintentar registro y cobro'
              : registered
                ? 'Completar registro'
                : selectedPlan
                  ? 'Registrar socio y cobro'
                  : kind === 'member'
                    ? 'Registrar socio'
                    : 'Registrar persona'
        }
        onSubmit={async (f) => {
          if (photo === undefined) throw Error('Espera a que termine de prepararse la foto.');
          if (pending.current || (!savedId.current && selectedPlan)) {
            if (!pending.current) {
              if (f.get('status') !== 'active') throw Error('El socio debe estar activo para registrar un plan.');
              pending.current = {
                request_id: newRequestId(),
                new_member: {
                  name: String(f.get('name') || ''),
                  document: String(f.get('document') || ''),
                  email: String(f.get('email') || ''),
                  phone: String(f.get('phone') || ''),
                  department: String(f.get('department') || ''),
                  notes: String(f.get('notes') || ''),
                  kind: kind as 'member' | 'employee',
                  status: 'active',
                },
                payment_method: f.get('payment_method') as PosCheckout['payment_method'],
                expected_total_cents: selectedPlan!.price_cents,
                lines: [
                  {
                    kind: 'plan',
                    id: selectedPlan!.id,
                    quantity: 1,
                    expected_plan: { unit: selectedPlan!.unit, duration: selectedPlan!.duration },
                  },
                ],
              };
            }
            try {
              const sale = await api<PosSaleDetail>('pos/checkout', 'POST', pending.current);
              savedId.current = sale.person_id!;
              pending.current = null;
              setUncertain(false);
              setRegistered(true);
            } catch (reason) {
              if (reason instanceof HttpError && reason.status < 500 && ![401, 403].includes(reason.status)) {
                pending.current = null;
                setUncertain(false);
                if (reason.status === 409) await loadPlans();
              } else setUncertain(true);
              throw reason;
            }
          } else if (person || !savedId.current) {
            if (!person && planHolder(kind) && planId && !selectedPlan)
              throw Error('El plan ya no está disponible. Elige otro antes de guardar.');
            const saved = await api<{ id: string }>(
              'people' + (savedId.current ? '/' + savedId.current : ''),
              savedId.current ? 'PATCH' : 'POST',
              {
                ...(person ? { zone_ids: person.zone_ids, schedule_id: person.schedule_id } : {}),
                ...Object.fromEntries(f),
                expires: f.get('expires') || null,
              },
            );
            savedId.current = saved.id;
            if (!person) setRegistered(true);
          }
          if (photo) {
            try {
              await upload('people/' + savedId.current + '/photo', photo);
            } catch (error) {
              throw Error(
                'La persona se guardó, pero la foto no pudo cargarse. Puedes reintentar sin duplicarla. ' +
                  (error as Error).message,
              );
            }
          }
          await onDone();
          onClose();
        }}
      >
        {uncertain && (
          <p className="error-message" role="alert">
            No se pudo confirmar el resultado. Reintenta esta misma operación antes de cerrar; los datos están
            bloqueados para evitar cobros duplicados.
          </p>
        )}
        {registered && (
          <p className="helper" role="status">
            El registro ya se guardó{selectedPlan ? ' junto con el cobro del plan' : ''}. Reintentar completa la foto y
            la actualización de la lista sin volver a cobrar.
          </p>
        )}
        <fieldset disabled={uncertain || registered}>
          {person?.photo_path && <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />}
          <PhotoEditor onChange={setPhoto} />
          <div className="form-grid">
            <Field label="Nombre completo">
              <input name="name" required maxLength={120} defaultValue={person?.name} placeholder="Nombre y apellido" />
            </Field>
            <Field label="Documento de identidad" hint="Su CI u otro número que lo identifique.">
              <input
                name="document"
                required
                maxLength={120}
                defaultValue={person?.document}
                placeholder="Ej. 1234567"
              />
            </Field>
            <Field label="WhatsApp" hint="Obligatorio para socios. Incluye el código de país, por ejemplo 59171234567.">
              <input
                name="phone"
                required={kind === 'member'}
                type="tel"
                inputMode="tel"
                maxLength={24}
                defaultValue={person?.phone}
                placeholder={kind === 'member' ? '59171234567' : 'Opcional'}
              />
            </Field>
            <Field label="¿Quién es?">
              <select
                name="kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as Person['kind']);
                  setPlanId('');
                }}
              >
                <option value="member">Socio del gimnasio</option>
                <option value="visitor">Visitante</option>
                {person?.kind === 'employee' && <option value="employee">Personal (ficha anterior)</option>}
              </select>
            </Field>
            {!person && planHolder(kind) && (
              <Field
                label={kind === 'member' ? 'Plan del socio' : 'Plan del personal'}
                hint="Opcional. Los planes se crean en Punto de venta, pestaña Planes."
              >
                <select
                  name="plan_id"
                  value={planId}
                  disabled={!plans}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  <option value="">{plans ? 'Sin plan por ahora' : 'Cargando planes…'}</option>
                  {plans?.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} · {plan.duration}{' '}
                      {plan.unit === 'days' ? 'día(s)' : plan.unit === 'months' ? 'mes(es)' : 'sesión(es)'} ·{' '}
                      {new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(
                        plan.price_cents / 100,
                      )}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {selectedPlan && (
              <Field label="¿Cómo pagó?">
                <select name="payment_method" defaultValue="cash">
                  <option value="cash">Efectivo</option>
                  <option value="transfer">Transferencia</option>
                  <option value="card">Tarjeta</option>
                </select>
              </Field>
            )}
          </div>
          {!person && planHolder(kind) && planError && (
            <p className="error-message" role="alert">
              No se pudieron cargar los planes: {planError}{' '}
              <button className="text-btn" type="button" onClick={() => void loadPlans()}>
                Reintentar carga
              </button>
            </p>
          )}
          {!person && planHolder(kind) && plans?.length === 0 && (
            <p className="helper">
              Todavía no hay planes activos. Puedes crearlos en Punto de venta, en la pestaña Planes.
            </p>
          )}
          {selectedPlan && (
            <div className="helper" aria-live="polite">
              <p>
                {selectedPlan.unit === 'sessions'
                  ? `${selectedPlan.duration} sesiones desde ${today}, sin vencimiento por fecha.`
                  : `Válido del ${today} al ${nextDate(end!, -1)}, inclusive.`}
              </p>
              <p>
                Al confirmar se registra el cobro de{' '}
                {new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(
                  selectedPlan.price_cents / 100,
                )}{' '}
                en Punto de venta. Confirma después de recibir el pago.
              </p>
            </div>
          )}
          <details className="more-fields" open={!!person}>
            <summary>Más datos (opcional)</summary>
            <div className="form-grid">
              <Field label="Correo electrónico">
                <input name="email" type="email" defaultValue={person?.email} placeholder="Opcional" />
              </Field>
              <Field label="Área o departamento">
                <input
                  name="department"
                  maxLength={100}
                  defaultValue={person?.department}
                  placeholder="Ej. Administración"
                />
              </Field>
              <Field label="Estado">
                <select name="status" defaultValue={person?.status || 'active'}>
                  <option value="active">Activo</option>
                  <option value="blocked">Suspendido (no puede entrar)</option>
                </select>
              </Field>
              <Field
                label="Válido hasta"
                hint={
                  !selectedPlan
                    ? 'Déjalo vacío si el acceso no vence.'
                    : kind !== 'member'
                      ? 'El acceso del personal no vence con el plan. Ajusta su vencimiento editando la ficha.'
                      : selectedPlan.unit === 'sessions'
                        ? 'El acceso depende de las sesiones disponibles, sin vencimiento por fecha.'
                        : 'Último día de acceso incluido en el plan. Se calcula automáticamente.'
                }
              >
                {selectedPlan ? (
                  <input
                    type="date"
                    name="expires"
                    value={kind === 'member' && end ? nextDate(end, -1) : ''}
                    readOnly
                  />
                ) : (
                  <input type="date" name="expires" defaultValue={person?.expires || ''} />
                )}
              </Field>
              <Field label="Notas">
                <textarea
                  name="notes"
                  rows={2}
                  maxLength={1000}
                  defaultValue={person?.notes}
                  placeholder="Información útil para recepción"
                />
              </Field>
            </div>
          </details>
        </fieldset>
      </Form>
      {person && planHolder(person.kind) && (
        <PersonMemberships
          personId={person.id}
          today={data.today}
          canSell={data.user.role !== 'viewer'}
          gated={person.kind === 'member'}
        />
      )}
    </Modal>
  );
}
/** Nombres cortos de cada método, para los textos de emisión y el resumen. */
const methodLabels: Record<string, string> = {
  qr: 'una tarjeta digital / QR',
  nfc: 'una tarjeta NFC',
  biometric: 'un identificador biométrico',
};
export function Credentials({
  person,
  data,
  notify,
  onClose,
  onChange,
}: {
  person: PersonSummary;
  data: Bootstrap;
  notify: Notify;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [list, setList] = useState<Credential[]>([]),
    [kind, setKind] = useState('qr'),
    [issued, setIssued] = useState<{ id: string; code: string; kind: string } | null>(null),
    [error, setError] = useState('');
  const load = async () => {
    try {
      setList(await api('people/' + person.id + '/credentials'));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const image =
    issued?.kind === 'qr' ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(issued.code)) : '';
  const [cardBusy, setCardBusy] = useState('');
  // La credencial se muestra con el mismo diseño que se descarga y se ve en Credenciales QR.
  const [cardImage, setCardImage] = useState('');
  useEffect(() => {
    setCardImage('');
    if (issued?.kind !== 'qr') return;
    let live = true;
    void (async () => {
      const [tools, { cardDataUri }] = await Promise.all([cardTools(), import('../lib/card')]);
      const card = await tools.credentialCardData(issued.id, data.settings);
      if (live) setCardImage(cardDataUri(card));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [issued?.id, issued?.kind, data.settings]);
  async function withCard(action: string, run: (card: CardData, tools: CardTools) => void | Promise<void>) {
    setCardBusy(action);
    try {
      const tools = await cardTools();
      await run(await tools.credentialCardData(issued!.id, data.settings), tools);
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setCardBusy('');
    }
  }
  return (
    <Modal title="Credenciales de acceso" onClose={onClose}>
      <div className="credential-person">
        <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />
        <div>
          <h3>{person.name}</h3>
          <p>
            {person.document} · {kindLabels[person.kind]}
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-message">
          {error}
        </div>
      )}
      {issued ? (
        <>
          {cardImage ? (
            <img className="credential-preview print-card" src={cardImage} alt={'Credencial de ' + person.name} />
          ) : (
          <div className="digital-card print-card">
            <div className="card-brand">
              {data.settings.logo_path && (
                <ScopedImage
                  className="organization-logo"
                  src={logoUrl(data.settings.logo_path)}
                  alt={'Logo de ' + data.settings.name}
                />
              )}
              GymPASS<span>.</span>
              <span className="card-org">{data.settings.name}</span>
            </div>
            <Badge tone="green">CREDENCIAL DIGITAL</Badge>
            <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />
            <h2>{person.name}</h2>
            <p>{person.department || kindLabels[person.kind]}</p>
            {image ? <img src={image} alt={'QR de acceso de ' + person.name} /> : <KeyRound size={56} />}
            {image && <strong className="qr-holder-name">{person.name}</strong>}
            <div className="card-id">ID {person.document}</div>
            <small>Acceso sujeto a permisos y planes vigentes</small>
          </div>
          )}
          {planHolder(person.kind) && (
            <PersonMemberships personId={person.id} today={data.today} compact gated={person.kind === 'member'} />
          )}
          <p className="helper">
            Conserva esta tarjeta: el QR es el mismo al renovar o cambiar de plan. El acceso se valida al leerlo según
            la vigencia del plan. Puedes descargarlo de nuevo desde Credenciales.
          </p>
          <div className="button-row">
            {image && (
              <>
                <ShareCredentialButton
                  id={issued.id}
                  name={person.name}
                  phone={person.phone}
                  settings={data.settings}
                  notify={notify}
                  disabled={!!cardBusy}
                />
                <button
                  className="btn primary"
                  disabled={!!cardBusy}
                  onClick={() => withCard('png', (card, { downloadCardPng }) => downloadCardPng(card))}
                >
                  <Download size={16} /> {cardBusy === 'png' ? 'Generando…' : 'Descargar tarjeta (PNG)'}
                </button>
                <button
                  className="btn secondary"
                  disabled={!!cardBusy}
                  onClick={() => withCard('svg', (card, { downloadCardSvg }) => downloadCardSvg(card))}
                >
                  <Download size={16} /> Tarjeta (SVG)
                </button>
                <button
                  className="btn secondary"
                  disabled={!!cardBusy}
                  onClick={() => withCard('print', (card, { printCardSheet }) => printCardSheet([card]))}
                >
                  <Printer size={16} /> Imprimir tarjeta
                </button>
                <a
                  className="btn secondary"
                  href={image}
                  download={'qr-' + person.document.replace(/[^a-zA-Z0-9_-]/g, '_') + '.svg'}
                >
                  <Download size={16} /> Solo el QR
                </a>
              </>
            )}
            <button
              className="btn secondary"
              onClick={async () => {
                try {
                  await copyText(issued.code);
                  notify('Código copiado');
                } catch {
                  notify('Selecciona y copia el código que aparece abajo.', true);
                }
              }}
            >
              <Copy size={16} /> Copiar código
            </button>
          </div>
          <details className="code-details">
            <summary>Ver código de credencial</summary>
            <code>{issued.code}</code>
          </details>
          <button className="text-btn" onClick={() => setIssued(null)}>
            Volver a las credenciales
          </button>
        </>
      ) : (
        <>
          {data.user.role === 'admin' && (
            <Form
              label={kind === 'qr' ? 'Ver o crear QR del socio' : 'Emitir credencial'}
              onSubmit={async (f) => {
                const result = await api('people/' + person.id + '/credentials', 'POST', Object.fromEntries(f));
                setIssued(result);
                await load();
                await onChange();
              }}
            >
              <div className="form-grid">
                <Field label="Método">
                  <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="qr">Tarjeta digital / QR</option>
                    <option value="nfc">Tarjeta NFC</option>
                    <option value="biometric">Identificador biométrico externo</option>
                  </select>
                </Field>
                <Field label="Nombre de la credencial">
                  <input name="label" required maxLength={120} defaultValue="Credencial principal" />
                </Field>
              </div>
              {kind !== 'qr' && (
                <Field
                  label={kind === 'nfc' ? 'Identificador de la tarjeta' : 'Identificador del usuario en el lector'}
                  hint={
                    kind === 'biometric'
                      ? 'El equipo debe verificar la biometría y enviar este identificador mediante la API.'
                      : 'Registra exactamente el valor que envía el lector NFC.'
                  }
                >
                  <input name="code" required minLength={4} maxLength={200} />
                </Field>
              )}
              <p className="helper">
                {kind === 'qr'
                  ? 'Cada socio conserva su mismo QR. Solo se crea uno si todavía no tiene. Renovar un plan actualiza la vigencia, sin cambiar la tarjeta.'
                  : `Emitir ${methodLabels[kind]} revoca solo la anterior del mismo método; las de los otros métodos siguen funcionando. La conexión física se realiza mediante un lector compatible con la API.`}
              </p>
            </Form>
          )}
          <div className="section-label">MÉTODOS ACTIVOS</div>
          <div className="credential-methods">
            {(['qr', 'nfc', 'biometric'] as const).map((method) => {
              const current = list.find((item) => item.kind === method && item.active);
              return (
                <Badge key={method} tone={current ? 'green' : 'gray'}>
                  {kindLabels[method]}: {current ? '···' + current.suffix : 'sin emitir'}
                </Badge>
              );
            })}
          </div>
          <div className="section-label">CREDENCIALES EMITIDAS</div>
          {!list.length ? (
            <p className="helper">Esta persona todavía no tiene credenciales.</p>
          ) : (
            list.map((c) => (
              <div className="credential-row" key={c.id}>
                <ScanLine size={20} />
                <div>
                  <strong>{c.label}</strong>
                  <small>
                    {kindLabels[c.kind]} · ···{c.suffix}
                  </small>
                </div>
                <Badge tone={c.active ? 'green' : 'gray'}>{c.active ? 'Activa' : 'Anulada'}</Badge>
                {!!c.downloadable && !!c.shareable && (
                  <ShareCredentialButton
                    id={c.id}
                    name={person.name}
                    phone={person.phone}
                    settings={data.settings}
                    notify={notify}
                    disabled={!!cardBusy}
                  />
                )}
                {!!c.downloadable && !!c.shareable && (
                  <button
                    className="icon-btn"
                    disabled={!!cardBusy}
                    aria-label={'Descargar ' + c.label}
                    onClick={async () => {
                      setCardBusy(c.id);
                      try {
                        const { credentialCardData, downloadCardPng } = await cardTools();
                        await downloadCardPng(await credentialCardData(c.id, data.settings));
                      } catch (reason) {
                        notify((reason as Error).message, true);
                      } finally {
                        setCardBusy('');
                      }
                    }}
                  >
                    <Download size={17} />
                  </button>
                )}
                {!!c.active && data.user.role === 'admin' && (
                  <button
                    className="icon-btn danger"
                    aria-label={'Anular ' + c.label}
                    onClick={async () => {
                      if (!confirm('¿Anular esta credencial? La persona ya no podrá entrar con ella.')) return;
                      try {
                        await api('credentials/' + c.id, 'PATCH', {});
                        await load();
                        await onChange();
                        notify('Credencial anulada');
                      } catch (e) {
                        notify((e as Error).message, true);
                      }
                    }}
                  >
                    <Ban size={17} />
                  </button>
                )}
              </div>
            ))
          )}
        </>
      )}
    </Modal>
  );
}
export default function People({
  data,
  reload,
  notify,
}: {
  data: Bootstrap;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const [q, setQ] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('q') || ''),
    [kind, setKind] = useState(''),
    [state, setState] = useState(''),
    [busyRow, setBusyRow] = useState(''),
    [page, setPage] = useState(1),
    [loadingDetail, setLoadingDetail] = useState(''),
    [edit, setEdit] = useState<Person | 'new' | null>(() =>
      new URLSearchParams(location.hash.split('?')[1]).has('new') ? 'new' : null,
    ),
    [credential, setCredential] = useState<PersonSummary | null>(null),
    [membership, setMembership] = useState<PersonSummary | null>(null);
  const directory = usePeople({ q, kind, state, page }),
    people = directory.rows;
  const viewingDeleted = state === 'deleted';
  async function run(person: PersonSummary, work: () => Promise<void>, done: string) {
    setBusyRow(person.id);
    try {
      await work();
      await reload();
      notify(done);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusyRow('');
    }
  }
  const personStatus = (person: PersonSummary) =>
    person.deleted_at ? (
      <Badge tone="gray">Dado de baja</Badge>
    ) : (
      <Badge
        tone={person.status === 'blocked' ? 'red' : person.expires && person.expires < data.today ? 'amber' : 'green'}
      >
        {person.status === 'blocked'
          ? 'Suspendido'
          : person.expires && person.expires < data.today
            ? 'Vencido'
            : 'Activo'}
      </Badge>
    );
  const personActions = (person: PersonSummary) =>
    person.deleted_at ? (
      <div className="row-actions">
        <a className="btn secondary small" href={'#history?q=' + encodeURIComponent(person.document)}>
          Movimientos
        </a>
        {data.user.role === 'admin' && (
          <button
            className="btn small primary"
            disabled={busyRow === person.id}
            onClick={() =>
              run(
                person,
                () => api('people/' + encodeURIComponent(person.id) + '/restore', 'POST'),
                'Ficha restaurada. Vuelve a emitirle sus credenciales.',
              )
            }
          >
            <RotateCcw size={15} /> {busyRow === person.id ? 'Restaurando…' : 'Restaurar'}
          </button>
        )}
      </div>
    ) : (
      <div className="row-actions">
        {data.user.role !== 'viewer' && (
          <a className="btn small primary" href={'#access?person=' + encodeURIComponent(person.id) + '&direction=auto'}>
            Entrada / salida
          </a>
        )}
        {planHolder(person.kind) && (
          <button className="btn secondary small" onClick={() => setMembership(person)}>
            Planes y cobros
          </button>
        )}
        <span className="row-links">
          {data.user.role !== 'viewer' && (
            <button className="link-action" onClick={() => setCredential(person)}>
              Credencial QR
            </button>
          )}
          <a className="link-action" href={'#attendance?person=' + encodeURIComponent(person.id)}>
            Tiempo en el gimnasio
          </a>
          <a className="link-action" href={'#history?q=' + encodeURIComponent(person.document)}>
            Movimientos
          </a>
          {data.user.role === 'admin' && (
            <button
              className="link-action"
              aria-label={'Editar ' + person.name}
              disabled={!!loadingDetail}
              onClick={async () => {
                setLoadingDetail(person.id);
                try {
                  setEdit(await api<Person>('people/' + encodeURIComponent(person.id)));
                } catch (error) {
                  notify((error as Error).message, true);
                } finally {
                  setLoadingDetail('');
                }
              }}
            >
              Editar ficha
            </button>
          )}
          {data.user.role === 'admin' && (
            <button
              className="link-action danger"
              disabled={busyRow === person.id}
              onClick={() => {
                if (
                  !confirm(
                    `¿Dar de baja a ${person.name}? Saldrá del directorio y se anularán sus credenciales. Su historial de accesos, planes y cobros se conserva y puedes restaurarla más tarde.`,
                  )
                )
                  return;
                void run(person, () => api('people/' + encodeURIComponent(person.id), 'DELETE'), 'Ficha dada de baja');
              }}
            >
              {busyRow === person.id ? 'Dando de baja…' : 'Dar de baja'}
            </button>
          )}
        </span>
      </div>
    );
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(directory.total / 50));
    if (!directory.busy && !directory.error && page > lastPage) setPage(lastPage);
  }, [directory.busy, directory.error, directory.total, page]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Socios</h1>
          <p>Busca a un socio o registra a una persona nueva.</p>
        </div>
        {data.user.role === 'admin' && !viewingDeleted && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Plus size={18} /> Registrar socio
          </button>
        )}
      </div>
      <div className="panel">
        <FilterBar
          activeCount={Number(!!q) + Number(!!kind) + Number(!!state)}
          onClear={() => {
            setQ('');
            setKind('');
            setState('');
            setPage(1);
          }}
        >
          <div className="search">
            <Search size={18} />
            <input
              aria-label="Buscar personas"
              placeholder="Buscar por nombre, documento o área…"
              value={q}
              maxLength={120}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            aria-label="Filtrar tipo de persona"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos los tipos</option>
            <option value="employee">Personal</option>
            <option value="visitor">Visitantes</option>
            <option value="member">Socios del gimnasio</option>
          </select>
          <select
            aria-label="Filtrar fichas dadas de baja"
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Personas activas</option>
            <option value="deleted">Dadas de baja</option>
          </select>
          <span className="count-label" role="status">
            {directory.busy ? 'Buscando…' : `${directory.total} personas`}
          </span>
        </FilterBar>
        {directory.error ? (
          <p className="error-message" role="alert">
            {directory.error}
          </p>
        ) : directory.busy ? (
          <Skeleton />
        ) : !people.length ? (
          <Empty
            title={
              viewingDeleted
                ? 'No hay fichas dadas de baja'
                : q
                  ? 'No encontramos coincidencias'
                  : 'Tu directorio empieza aquí'
            }
            text={
              viewingDeleted
                ? 'Las fichas que des de baja aparecerán aquí y podrás restaurarlas.'
                : q
                  ? 'Prueba con otro nombre o documento.'
                  : 'Registra a tu primer socio para poder darle su credencial QR.'
            }
            action={
              !q && !viewingDeleted && data.user.role === 'admin' ? (
                <button className="btn primary" onClick={() => setEdit('new')}>
                  <Plus size={16} /> Registrar persona
                </button>
              ) : undefined
            }
          />
        ) : (
          <RecordList
            rows={people}
            getKey={(person) => person.id}
            state={{ status: 'ready' }}
            emptyText="No hay personas en esta búsqueda."
            headers={
              <tr>
                <th>Persona</th>
                <th>Tipo / área</th>
                <th>Credenciales</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            }
            renderDesktopRow={(person) => (
              <>
                <td>
                  <div className="person-cell">
                    <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />
                    <div>
                      <strong>{person.name}</strong>
                      <small>{person.document}</small>
                    </div>
                  </div>
                </td>
                <td>
                  {kindLabels[person.kind]}
                  <small>{person.department || 'Sin área asignada'}</small>
                </td>
                <td>{person.credential_count} credenciales activas</td>
                <td>{personStatus(person)}</td>
                <td>{personActions(person)}</td>
              </>
            )}
            renderMobileItem={(person) => (
              <>
                <header>
                  <Avatar name={person.name} personId={person.id} photoPath={person.photo_path} />
                  <div>
                    <strong>{person.name}</strong>
                    <small>{person.document}</small>
                  </div>
                </header>
                {personStatus(person)}
                <dl>
                  <dt>Tipo</dt>
                  <dd>{kindLabels[person.kind]}</dd>
                  <dt>Área</dt>
                  <dd>{person.department || 'Sin área asignada'}</dd>
                  <dt>Credenciales</dt>
                  <dd>{person.credential_count} activas</dd>
                </dl>
                {personActions(person)}
              </>
            )}
          />
        )}
        <div className="pagination">
          <span>{directory.busy ? 'Consultando…' : `${people.length} de ${directory.total} personas`}</span>
          <div>
            <button
              className="icon-btn"
              aria-label="Página anterior de personas"
              disabled={directory.busy || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              Página {page} de {Math.max(1, Math.ceil(directory.total / 50))}
            </span>
            <button
              className="icon-btn"
              aria-label="Página siguiente de personas"
              disabled={directory.busy || page * 50 >= directory.total}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        {loadingDetail && (
          <p className="helper" role="status">
            Abriendo ficha…
          </p>
        )}
      </div>
      {edit && (
        <PersonForm
          data={data}
          person={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(null)}
          onDone={async () => {
            await reload();
            notify(edit === 'new' ? 'Persona registrada' : 'Persona actualizada');
          }}
        />
      )}
      {credential && (
        <Credentials
          data={data}
          person={credential}
          onClose={() => setCredential(null)}
          onChange={reload}
          notify={notify}
        />
      )}
      {membership && (
        <Modal title={'Planes y cobros · ' + membership.name} wide onClose={() => setMembership(null)}>
          <PersonMemberships
            personId={membership.id}
            today={data.today}
            canSell={data.user.role !== 'viewer'}
            gated={membership.kind === 'member'}
          />
        </Modal>
      )}
    </>
  );
}
