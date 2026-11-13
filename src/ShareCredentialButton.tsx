import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, MessageCircle } from 'lucide-react';
import type { Settings } from '../lib/domain';
import { Modal, type Notify } from './ui';
import { upload } from './api';
import {
  canShareCredential,
  credentialMessage,
  credentialWhatsappUrl,
  prepareCredentialPng,
} from './credential-sharing';
import { copyCredentialImage } from './native-files';

type Props = {
  id: string;
  name: string;
  phone?: string;
  settings: Pick<Settings, 'name' | 'brand_color' | 'logo_path' | 'credential_color' | 'credential_watermark_size'>;
  notify: Notify;
  disabled?: boolean;
};
export default function ShareCredentialButton({ id, name, phone, settings, disabled }: Props) {
  const [open, setOpen] = useState(false),
    [prepared, setPrepared] = useState<{ file: File; name: string; preview: string } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [link, setLink] = useState<string | null>(null),
    [linkFailed, setLinkFailed] = useState(false);
  const nativeShare = !!window.__gympassShareCredential;
  const chat = credentialWhatsappUrl(phone, prepared?.name || name, settings.name);
  // With a private link the chat opens at the member's number and WhatsApp previews the card.
  const chatWithLink = link ? credentialWhatsappUrl(phone, prepared?.name || name, settings.name, link) : null;
  // WhatsApp only turns real web addresses into links, and a phone cannot reach this computer's own address.
  const linkReachable =
    !!link && /^https:\/\//.test(link) && !/^https:\/\/(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/)/.test(link);
  const linkPending = !nativeShare && !!prepared && !link && !linkFailed;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let live = true,
      preview: string | undefined;
    setPrepared(null);
    setLink(null);
    setLinkFailed(false);
    setError('');
    void prepareCredentialPng(id, settings, controller.signal)
      .then((result) => {
        if (!live) return;
        preview = URL.createObjectURL(result.file);
        setPrepared({ ...result, preview });
        if (window.__gympassShareCredential) return;
        upload('credentials/' + encodeURIComponent(id) + '/share', result.file)
          .then((created) => {
            if (live) setLink(location.origin + created.path);
          })
          .catch(() => {
            if (live) setLinkFailed(true);
          });
      })
      .catch((reason) => {
        if (live) setError((reason as Error).message);
      });
    return () => {
      live = false;
      controller.abort();
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [open, id, settings.name, settings.brand_color]);
  async function download() {
    if (!prepared) return;
    try {
      const { saveBlob } = await import('./card-download');
      await saveBlob(prepared.file, prepared.file.name);
    } catch {
      setError('No se pudo descargar el PNG. Vuelve a intentarlo.');
    }
  }
  const systemShare = !!prepared && !window.gympassDesktop && canShareCredential(prepared.file);
  async function copy() {
    if (!prepared) return;
    setError('');
    try {
      await copyCredentialImage(prepared.file);
      setStatus('Imagen copiada. Pégala en WhatsApp.');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  // The Android app shares the image and message straight to the member's number.
  async function share() {
    if (!prepared || !chat || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await window.__gympassShareCredential?.(
        prepared.file,
        credentialMessage(prepared.name, settings.name),
        (phone || '').replace(/\D/g, ''),
      );
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // In a browser the chat is a plain link to the member's number, like the renewal notice, so no
  // popup blocker can interfere. WhatsApp links cannot carry an image: the click copies the card
  // (while the page still has focus) so it can be pasted into the chat before sending.
  function openChat() {
    if (!prepared) return;
    setError('');
    setStatus('');
    copyCredentialImage(prepared.file).then(
      () =>
        setStatus(
          link
            ? 'Chat abierto con el enlace de la credencial. La imagen también quedó copiada por si prefieres pegarla (Ctrl+V o ⌘V).'
            : 'Imagen copiada. En el chat pégala con Ctrl+V (⌘V en Mac) y confirma el envío.',
        ),
      () =>
        setStatus(
          link
            ? 'Chat abierto con el enlace de la credencial. Confirma el envío en WhatsApp.'
            : 'No se pudo copiar la imagen. Descarga el PNG y adjúntalo en el chat antes de enviar.',
        ),
    );
  }
  // Optional route through the system share sheet; it cannot choose the member's chat.
  async function shareWithOtherApp() {
    if (!prepared || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await navigator.share({
        files: [prepared.file],
        text: credentialMessage(prepared.name, settings.name),
        title: 'Credencial de ' + prepared.name,
      });
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="btn secondary small"
        disabled={disabled || !chat}
        title={!chat ? 'Registra el WhatsApp del socio en su ficha.' : undefined}
        aria-label={'Enviar credencial de ' + name + ' por WhatsApp'}
        onClick={() => {
          setPrepared(null);
          setError('');
          setStatus('');
          setOpen(true);
        }}
      >
        <MessageCircle size={16} /> Enviar por WhatsApp
      </button>
      {open &&
        createPortal(
          <Modal
            title="Enviar credencial al WhatsApp del socio"
            onClose={() => {
              setPrepared(null);
              setOpen(false);
            }}
          >
            <p>
              Tarjeta de <strong>{name}</strong> con su QR actual.
            </p>
            <p className="helper">El chat se abre por su número con código de país; no necesitas guardar al socio en tus contactos.</p>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {!prepared && !error && <p role="status">Preparando la imagen PNG…</p>}
            {prepared && (
              <>
                <img className="credential-preview" src={prepared.preview} alt={'Credencial QR de ' + prepared.name} />
                <p className="helper">
                  {nativeShare
                    ? `Se abrirá WhatsApp para ${phone} con la imagen y el mensaje preparados. Confirma el envío allí.`
                    : link && !linkReachable
                      ? `Atención: este enlace usa la dirección de este equipo (${new URL(link).host}). WhatsApp no lo mostrará como enlace y el socio no podrá abrirlo; solo funciona desde la dirección pública (https) del gimnasio.`
                      : link
                        ? `Se abrirá el chat de ${phone} con el mensaje y un enlace privado a la tarjeta, que vence en 7 días. WhatsApp mostrará la credencial como vista previa.`
                        : linkFailed
                          ? `No se pudo crear el enlace de la credencial. Puedes abrir el chat de ${phone} y pegar la imagen copiada con Ctrl+V (⌘V en Mac).`
                          : 'Preparando el enlace privado de la credencial…'}{' '}
                </p>
                {status && <p role="status">{status}</p>}
                <div className="button-row">
                  {chat &&
                    (nativeShare ? (
                      <button className="btn primary" disabled={busy} onClick={share}>
                        <MessageCircle size={16} /> Abrir WhatsApp con credencial
                      </button>
                    ) : linkPending ? (
                      <button className="btn primary" disabled>
                        <MessageCircle size={16} /> Preparando enlace…
                      </button>
                    ) : (
                      <a
                        className="btn primary"
                        href={chatWithLink || chat}
                        target="_blank"
                        rel="noreferrer"
                        onClick={openChat}
                      >
                        <MessageCircle size={16} />{' '}
                        {link ? 'Abrir chat del socio con la credencial' : 'Abrir chat del socio y copiar imagen'}
                      </a>
                    ))}
                  {systemShare && !nativeShare && (
                    <button className="btn secondary" disabled={busy} onClick={shareWithOtherApp}>
                      Compartir con otra app
                    </button>
                  )}
                  <button className="btn secondary" disabled={busy} onClick={copy}>
                    <Copy size={16} /> Copiar imagen
                  </button>
                  <button className="btn secondary" disabled={busy} onClick={download}>
                    <Download size={16} /> Descargar PNG
                  </button>
                </div>
              </>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
