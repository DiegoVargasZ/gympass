import { apiUrl } from './platform-context';
import ScopedImage from './ScopedImage';
import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type FormEvent,
} from 'react';
import { X, LoaderCircle, Inbox, ArrowDownLeft, ArrowUpRight, Check } from 'lucide-react';
import { reasons, kindLabels, type AccessEvent } from '../lib/domain';
import Records from './ui/RecordList';
export type Notify = (message: string, error?: boolean) => void;
export { default as PageHeader } from './ui/PageHeader';
export { default as StatusBadge } from './ui/StatusBadge';
export { default as FilterBar } from './ui/FilterBar';
export { default as RecordList } from './ui/RecordList';
export { default as EditorActions } from './ui/EditorActions';
let openModalCount = 0;
let previousBodyOverflow = '';
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = '',
  protectChanges = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  protectChanges?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const requestClose = () => {
    if (
      protectChanges &&
      ref.current?.querySelector('[data-dirty="true"]') &&
      !confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?')
    )
      return;
    onClose();
  };
  close.current = requestClose;
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current!;
    const focusable = () =>
      Array.from(el.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex="0"]')).filter(
        (x) => !x.hasAttribute('disabled') && x.getAttribute('tabindex') !== '-1' && x.getClientRects().length > 0,
      );
    (el.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== el) return;
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') {
        const nodes = focusable();
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    if (openModalCount === 0) previousBodyOverflow = document.body.style.overflow;
    openModalCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      openModalCount -= 1;
      if (openModalCount === 0) document.body.style.overflow = previousBodyOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={ref}
        className={'modal ' + (wide ? 'wide ' : '') + className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={requestClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Form({
  id,
  onSubmit,
  children,
  label = 'Guardar cambios',
  onCancel,
  disabled = false,
  submitDisabled = false,
  unsaved,
}: {
  id?: string;
  onSubmit: (form: FormData) => Promise<void>;
  children: ReactNode;
  label?: string;
  onCancel?: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  unsaved?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || disabled || submitDisabled) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(new FormData(e.currentTarget));
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      id={id}
      onSubmit={submit}
      className="form"
      data-dirty={unsaved ?? dirty}
      aria-busy={busy}
      onChange={() => setDirty(true)}
    >
      <fieldset disabled={busy || disabled}>{children}</fieldset>
      {error && (
        <div ref={errorRef} tabIndex={-1} className="error-message" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        {onCancel && (
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              if (!(unsaved ?? dirty) || confirm('Hay cambios sin guardar. ¿Descartarlos?')) {
                setDirty(false);
                onCancel();
              }
            }}
          >
            Cancelar
          </button>
        )}
        <button className="btn primary" disabled={busy || disabled || submitDisabled}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />} {busy ? 'Guardando…' : label}
        </button>
      </div>
    </form>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {Children.map(children, (child) =>
        isValidElement(child) && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type)
          ? cloneElement(child as ReactElement<Record<string, unknown>>, {
              id,
              'aria-describedby': hint ? id + '-hint' : undefined,
            })
          : child,
      )}
      {hint && <small id={id + '-hint'}>{hint}</small>}
    </div>
  );
}
export function Empty({
  title = 'Todavía no hay registros',
  text,
  action,
}: {
  title?: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: string }) {
  return <span className={'badge ' + tone}>{children}</span>;
}
export function Avatar({
  name,
  personId,
  photoPath,
}: {
  name: string;
  personId?: string | null;
  photoPath?: string | null;
}) {
  if (personId && photoPath)
    return (
      <ScopedImage
        className="avatar person-photo"
        src={apiUrl('people/' + encodeURIComponent(personId) + '/photo?v=' + encodeURIComponent(photoPath))}
        alt={'Foto de ' + name}
        loading="lazy"
      />
    );
  return (
    <span className="avatar">
      {name
        .split(' ')
        .map((s) => s[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()}
    </span>
  );
}
export function stamp(ms: number, tz: string, date = false) {
  return new Intl.DateTimeFormat('es-BO', {
    timeZone: tz,
    ...(date ? ({ day: '2-digit', month: 'short' } as const) : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}
export function EventTable({
  events,
  timezone,
  compact = false,
}: {
  events: AccessEvent[];
  timezone: string;
  compact?: boolean;
}) {
  const outcome = (event: AccessEvent) => (
    <>
      <Badge tone={event.reason === 'AUTO_CLOSE' ? 'amber' : event.allowed ? 'green' : 'red'}>
        {event.reason === 'AUTO_CLOSE' ? 'Cierre automático' : event.allowed ? 'Permitido' : 'Denegado'}
      </Badge>
      {event.reason === 'AUTO_CLOSE' && <small className="auto-close-note">Salida estimada</small>}
      {!event.allowed && <small>{reasons[event.reason] || event.reason}</small>}
    </>
  );
  return (
    <Records
      rows={events}
      getKey={(event) => event.id}
      state={{ status: 'ready' }}
      emptyText="Las entradas, salidas e intentos rechazados aparecerán aquí."
      headers={
        <tr>
          <th>Persona</th>
          <th>Movimiento</th>
          {!compact && <th>Método</th>}
          <th>Resultado</th>
          <th>Hora</th>
        </tr>
      }
      renderDesktopRow={(event) => (
        <>
          <td>
            <div className="person-cell">
              <Avatar name={event.person_name} personId={event.person_id} photoPath={event.photo_path} />
              <div>
                <strong>{event.person_name}</strong>
                {event.detail && <small title={event.detail}>{event.detail}</small>}
              </div>
            </div>
          </td>
          <td>
            <span className={'movement ' + event.direction}>
              {event.direction === 'entry' ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}
              {event.direction === 'entry' ? 'Entrada' : 'Salida'}
            </span>
          </td>
          {!compact && <td>{kindLabels[event.method] || event.method}</td>}
          <td>{outcome(event)}</td>
          <td className="mono nowrap">{stamp(event.occurred_at, timezone, !compact)}</td>
        </>
      )}
      renderMobileItem={(event) => (
        <>
          <header>
            <Avatar name={event.person_name} personId={event.person_id} photoPath={event.photo_path} />
            <div>
              <strong>{event.person_name}</strong>
              <small>
                {stamp(event.occurred_at, timezone, !compact)} · {event.direction === 'entry' ? 'Entrada' : 'Salida'}
              </small>
            </div>
          </header>
          {outcome(event)}
          <details>
            <summary>Ver detalle del movimiento</summary>
            <dl>
              <dt>Zona</dt>
              <dd>{event.zone_name}</dd>
              <dt>Método</dt>
              <dd>{kindLabels[event.method] || event.method}</dd>
              <dt>Motivo</dt>
              <dd>{reasons[event.reason] || event.reason}</dd>
              {event.detail && (
                <>
                  <dt>Detalle</dt>
                  <dd>{event.detail}</dd>
                </>
              )}
            </dl>
          </details>
        </>
      )}
    />
  );
}
export function Skeleton({ rows = 4, label = 'Cargando registros' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-block" role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" aria-hidden="true" key={index}>
          <i />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
