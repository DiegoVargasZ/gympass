import { useEffect, useState } from 'react';
import { Ban, Download, IdCard, Printer, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from './api';
import { type Bootstrap, kindLabels } from '../lib/domain';
import { cardDataUri, type CardData } from '../lib/card';
import { Avatar, Badge, Empty, Field, Skeleton, Modal, stamp, type Notify } from './ui';
import { downloadCardSheet, downloadCardPng, printCardSheet } from './card-download';
import { credentialCardData } from './credential-cards';
import ShareCredentialButton from './ShareCredentialButton';

type CredentialRow = {
  id: string;
  kind: string;
  label: string;
  suffix: string;
  active: number;
  created_at: number;
  person_id: string;
  person_name: string;
  phone: string;
  document: string;
  department: string;
  person_kind: string;
  person_status: string;
  expires: string | null;
  photo_path: string | null;
  downloadable: number;
};

export default function Credentials({ data, notify }: { data: Bootstrap; notify: Notify }) {
  const admin = data.user.role === 'admin';
  const [preview, setPreview] = useState<CardData | null>(null);
  const [q, setQ] = useState(''),
    [state, setState] = useState('active'),
    [page, setPage] = useState(1),
    [rows, setRows] = useState<CredentialRow[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [working, setWorking] = useState(''),
    [revision, setRevision] = useState(0);

  useEffect(() => {
    setSelected(new Set());
  }, [q, state, page]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ q, state, page: String(page) }).toString();
      api<{ rows: CredentialRow[]; total: number }>('credentials?' + query)
        .then((result) => {
          if (!live) return;
          setRows(result.rows);
          setTotal(result.total);
        })
        .catch((reason) => {
          if (live) setError(reason.message);
        })
        .finally(() => {
          if (live) setBusy(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, state, page, revision]);

  const selectable = rows.filter((row) => row.active && row.downloadable);
  const chosen = selectable.filter((row) => selected.has(row.id));
  const toggle = (personId: string) =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });

  async function issueCards(people: CredentialRow[], action: 'download' | 'print') {
    setWorking(action);
    try {
      const cards: CardData[] = [];
      for (const row of people) {
        cards.push(await credentialCardData(row.id, data.settings));
      }
      if (action === 'print') printCardSheet(cards);
      else if (cards.length === 1) await downloadCardPng(cards[0]);
      else downloadCardSheet(cards);
      setSelected(new Set());
      setRevision((value) => value + 1);
      notify(
        action === 'print' ? 'Tarjetas preparadas para imprimir' : 'Tarjetas descargadas. Los QR conservan su validez.',
      );
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  async function downloadOne(row: CredentialRow) {
    setWorking(row.id);
    try {
      await downloadCardPng(await credentialCardData(row.id, data.settings));
      notify('Tarjeta descargada');
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  async function prepareLegacy(row: CredentialRow) {
    if (
      !confirm(
        'Esta tarjeta es de una versión anterior. Se creará un QR nuevo y el anterior dejará de funcionar; después podrás descargarla cuando quieras. ¿Continuar?',
      )
    )
      return;
    setWorking(row.id);
    try {
      const result = await api<{ id: string }>('people/' + row.person_id + '/credentials', 'POST', {
        kind: 'qr',
        label: row.label,
      });
      await downloadCardPng(await credentialCardData(result.id, data.settings));
      notify('Tarjeta preparada y descargada');
    } catch (reason) {
      notify((reason as Error).message, true);
    } finally {
      setWorking('');
      setRevision((value) => value + 1);
    }
  }

  async function previewCard(row: CredentialRow) {
    setWorking(row.id);
    try {
      setPreview(await credentialCardData(row.id, data.settings));
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  async function revoke(row: CredentialRow) {
    if (!confirm('¿Anular esta credencial? La persona ya no podrá entrar con ella.')) return;
    setWorking(row.id);
    try {
      await api('credentials/' + row.id, 'PATCH', {});
      setRevision((value) => value + 1);
      notify('Credencial anulada');
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setWorking('');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Credenciales QR</h1>
          <p>Cada socio muestra su tarjeta con QR para entrar. Descárgala o imprímela desde aquí.</p>
        </div>
        {admin && (
          <div className="heading-actions">
            <button
              className="btn secondary"
              disabled={!chosen.length || !!working}
              onClick={() => issueCards(chosen, 'download')}
            >
              <Download size={17} /> Descargar {chosen.length || ''} tarjeta{chosen.length === 1 ? '' : 's'}
            </button>
            <button
              className="btn primary"
              disabled={!chosen.length || !!working}
              onClick={() => issueCards(chosen, 'print')}
            >
              <Printer size={17} /> {working === 'print' ? 'Preparando…' : 'Imprimir tarjetas'}
            </button>
          </div>
        )}
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="search">
            <Search size={18} />
            <input
              aria-label="Buscar credenciales"
              placeholder="Buscar por nombre o documento"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Field label="Estado">
            <select
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Todas</option>
              <option value="active">Activas</option>
              <option value="revoked">Anuladas</option>
            </select>
          </Field>
          <span className="count-label">{total} credenciales</span>
        </div>

        {admin && !chosen.length && !!rows.length && (
          <p className="helper selection-note">
            Marca a una o más personas de la lista para descargar o imprimir sus tarjetas.
          </p>
        )}
        {admin && !!chosen.length && (
          <p className="helper selection-note">
            {chosen.length} {chosen.length === 1 ? 'tarjeta seleccionada' : 'tarjetas seleccionadas'}. Ya puedes
            descargarlas o imprimirlas.
          </p>
        )}

        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : busy ? (
          <Skeleton rows={5} label="Cargando credenciales" />
        ) : !rows.length ? (
          <Empty title="Sin credenciales" text="Se crean al registrar a un socio. Ve a Socios y registra al primero." />
        ) : (
          <div className="credential-records">
            <div className="record-desktop table-scroll">
              <table>
                <thead>
                  <tr>
                    {admin && <th className="pick-column">Sel.</th>}
                    <th>Persona</th>
                    <th>Credencial</th>
                    <th>Emitida</th>
                    <th>Estado</th>
                    {admin && <th>Acciones</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      {admin && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={'Seleccionar a ' + row.person_name}
                            disabled={!row.active || !row.downloadable}
                            checked={selected.has(row.id)}
                            onChange={() => toggle(row.id)}
                          />
                        </td>
                      )}
                      <td>
                        <div className="person-cell">
                          <Avatar name={row.person_name} personId={row.person_id} photoPath={row.photo_path} />
                          <div>
                            <strong>{row.person_name}</strong>
                            <small>
                              {row.document}
                              {row.department ? ' · ' + row.department : ''}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong className="normal">{row.label}</strong>
                        <small>
                          {kindLabels[row.kind] || row.kind} · ···{row.suffix}
                        </small>
                      </td>
                      <td className="mono nowrap">{stamp(row.created_at, data.settings.timezone, true)}</td>
                      <td>
                        <Badge tone={row.active ? 'green' : 'gray'}>{row.active ? 'Activa' : 'Anulada'}</Badge>
                        {row.person_status !== 'active' && <small>Persona suspendida</small>}
                      </td>
                      {admin && (
                        <td>
                          <div className="row-actions">
                            {!!row.downloadable && (
                              <ShareCredentialButton
                                id={row.id}
                                name={row.person_name}
                                phone={row.phone}
                                settings={data.settings}
                                notify={notify}
                                disabled={!!working}
                              />
                            )}
                            {!!row.downloadable && (
                              <button
                                className="btn small secondary"
                                disabled={!!working}
                                onClick={() => void previewCard(row)}
                              >
                                Vista previa
                              </button>
                            )}
                            {!!row.downloadable && (
                              <button
                                className="btn small secondary"
                                disabled={!!working}
                                onClick={() => void downloadOne(row)}
                                aria-label={'Descargar tarjeta de ' + row.person_name}
                              >
                                <Download size={16} /> {working === row.id ? 'Generando…' : 'Tarjeta PNG'}
                              </button>
                            )}
                            {!!row.active && row.kind === 'qr' && !row.downloadable && (
                              <button
                                className="btn small secondary"
                                disabled={!!working}
                                onClick={() => void prepareLegacy(row)}
                              >
                                Actualizar tarjeta
                              </button>
                            )}
                            {!!row.active && (
                              <button
                                className="btn small secondary danger"
                                aria-label={'Anular ' + row.label + ' de ' + row.person_name}
                                onClick={async () => {
                                  if (!confirm('¿Anular esta credencial? La persona ya no podrá entrar con ella.'))
                                    return;
                                  try {
                                    await api('credentials/' + row.id, 'PATCH', {});
                                    setRevision((value) => value + 1);
                                    notify('Credencial anulada');
                                  } catch (reason) {
                                    notify((reason as Error).message, true);
                                  }
                                }}
                              >
                                <Ban size={17} /> Anular
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="record-mobile">
              {rows.map((row) => (
                <article className="record-item" key={row.id}>
                  <header>
                    <Avatar name={row.person_name} personId={row.person_id} photoPath={row.photo_path} />
                    <div>
                      <strong>{row.person_name}</strong>
                      <small>{row.document}</small>
                    </div>
                    {admin && (
                      <input
                        type="checkbox"
                        aria-label={'Seleccionar a ' + row.person_name}
                        disabled={!row.active || !row.downloadable}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    )}
                  </header>
                  <Badge tone={row.active ? 'green' : 'gray'}>{row.active ? 'Activa' : 'Anulada'}</Badge>
                  <dl>
                    <dt>Credencial</dt>
                    <dd>
                      {row.label} · {kindLabels[row.kind] || row.kind} · ···{row.suffix}
                    </dd>
                    <dt>Emitida</dt>
                    <dd>{stamp(row.created_at, data.settings.timezone, true)}</dd>
                  </dl>
                  {row.person_status !== 'active' && <p>Persona suspendida</p>}
                  {admin && (
                    <div className="row-actions">
                      {!!row.downloadable && (
                        <ShareCredentialButton
                          id={row.id}
                          name={row.person_name}
                          phone={row.phone}
                          settings={data.settings}
                          notify={notify}
                          disabled={!!working}
                        />
                      )}
                      {!!row.downloadable && (
                        <>
                          <button
                            className="btn secondary small"
                            disabled={!!working}
                            onClick={() => void previewCard(row)}
                          >
                            Vista previa
                          </button>
                          <button
                            className="btn secondary small"
                            disabled={!!working}
                            onClick={() => void downloadOne(row)}
                          >
                            <Download size={16} /> Tarjeta PNG
                          </button>
                        </>
                      )}
                      {!!row.active && row.kind === 'qr' && !row.downloadable && (
                        <button
                          className="btn secondary small"
                          disabled={!!working}
                          onClick={() => void prepareLegacy(row)}
                        >
                          Actualizar tarjeta
                        </button>
                      )}
                      {!!row.active && (
                        <button
                          className="btn secondary small danger"
                          disabled={!!working}
                          onClick={() => void revoke(row)}
                        >
                          Anular credencial
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}

        <div className="pagination">
          <span>{busy ? 'Consultando…' : `${total} credenciales`}</span>
          <div>
            <button
              className="icon-btn"
              aria-label="Página anterior"
              disabled={busy || page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              Página {page} de {Math.max(1, Math.ceil(total / 50))}
            </span>
            <button
              className="icon-btn"
              aria-label="Página siguiente"
              disabled={busy || page * 50 >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>

      {preview && (
        <Modal title="Vista previa de credencial" onClose={() => setPreview(null)}>
          <img
            className="credential-preview"
            src={cardDataUri(preview)}
            alt="Vista previa de la tarjeta con su QR actual"
          />
          <p className="helper">Descargar no registra ninguna entrada.</p>
        </Modal>
      )}
      <p className="helper">
        <IdCard size={14} /> Puedes descargar una tarjeta las veces que quieras; su QR no cambia.
      </p>
    </>
  );
}
