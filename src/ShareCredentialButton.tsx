import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, MessageCircle } from 'lucide-react';
import type { Settings } from '../lib/domain';
import { Modal, type Notify } from './ui';
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
    [status, setStatus] = useState('');
  const chat = credentialWhatsappUrl(phone, prepared?.name || name, settings.name);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let live = true,
      preview: string | undefined;
    setPrepared(null);
    setError('');
    void prepareCredentialPng(id, settings, controller.signal)
      .then((result) => {
        if (!live) return;
        preview = URL.createObjectURL(result.file);
        setPrepared({ ...result, preview });
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
  const nativeShare = !!window.__gympassShareCredential;
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
  async function share() {
    if (!prepared || !chat || busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    // Open during the click, before clipboard promises, to retain browser popup permission.
    const target = !nativeShare && !systemShare ? window.open('about:blank', '_blank') : null;
    if (target) target.opener = null;
    try {
      const text = credentialMessage(prepared.name, settings.name);
      if (window.__gympassShareCredential)
        await window.__gympassShareCredential(prepared.file, text, (phone || '').replace(/\D/g, ''));
      else if (systemShare)
        await navigator.share({ files: [prepared.file], text, title: 'Credencial de ' + prepared.name });
      else {
        await copyCredentialImage(prepared.file);
        if (target) target.location.href = chat;
        else window.open(chat, '_blank', 'noopener');
        setStatus('Imagen copiada. Pégala en el chat y confirma el envío en WhatsApp.');
      }
    } catch (cause) {
      target?.close();
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
                    : systemShare
                      ? 'Elige WhatsApp para compartir la imagen y el mensaje juntos. Confirma el envío allí.'
                      : `Se copiará la imagen y se abrirá el chat de ${phone} con el mensaje. Pega la imagen con Ctrl+V y confirma el envío.`}
                </p>
                {status && <p role="status">{status}</p>}
                <div className="button-row">
                  {chat && (
                    <button className="btn primary" disabled={busy} onClick={share}>
                      <MessageCircle size={16} />{' '}
                      {nativeShare
                        ? 'Abrir WhatsApp con credencial'
                        : systemShare
                          ? 'Compartir imagen y mensaje'
                          : 'Copiar imagen y abrir WhatsApp'}
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
