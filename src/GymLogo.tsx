import { useEffect, useState } from 'react';
import { ImageUp } from 'lucide-react';
import { api, upload } from './api';
import { logoUrl } from './branding';
import ScopedImage from './ScopedImage';
import type { Notify } from './ui';

const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const maxSide = 1024;

const maxBytes = 1024 * 1024;

function loadImage(file: Blob) {
  return new Promise<{ image: HTMLImageElement; release: () => void }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, release: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(Error('No se pudo leer la imagen. Prueba a exportarla como PNG.'));
    };
    image.src = url;
  });
}

// El servidor acepta PNG o WebP de hasta 1 MB y 2048 px, y solo SVG muy simples.
// Por eso todo lo que no sea ya un PNG o WebP pequeño se dibuja aquí con fondo transparente:
// los vectores (SVG) se rasterizan a buena resolución y, si el resultado pesa demasiado,
// se comprime como WebP o se reduce hasta que entra.
async function prepareLogo(file: File): Promise<Blob> {
  const { image, release } = await loadImage(file);
  try {
    const vector = file.type === 'image/svg+xml';
    const width = image.naturalWidth || 1024,
      height = image.naturalHeight || 1024;
    const longest = Math.max(width, height);
    if (!vector && file.type !== 'image/jpeg' && longest <= maxSide && file.size <= maxBytes) return file;
    // Un vector no tiene resolución propia: se dibuja siempre al tamaño máximo.
    let side = vector ? maxSide : Math.min(maxSide, longest);
    for (;;) {
      const scale = side / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const type of ['image/png', 'image/webp']) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
        // Un navegador sin WebP devuelve PNG aunque se pida otro formato.
        if (blob && blob.type === type && blob.size <= maxBytes) return blob;
      }
      if (side <= 256) throw Error('No se pudo reducir la imagen por debajo de 1 MB.');
      side = Math.round(side * 0.75);
    }
  } finally {
    release();
  }
}

export default function GymLogo({
  name,
  logoPath,
  size,
  saved,
  notify,
}: {
  name: string;
  logoPath: string | null;
  size: number;
  saved: () => Promise<void>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(size);
  useEffect(() => setDraft(size), [size]);
  // El arrastre se ve al instante en la marca de agua; se guarda al soltar el control.
  const preview = (value: number) => {
    setDraft(value);
    document.querySelector<HTMLElement>('.gym-watermark')?.style.setProperty('--gym-watermark-size', String(value));
  };
  const saveSize = async () => {
    if (draft === size) return;
    setError('');
    try {
      await api('settings', 'PATCH', { logo_watermark_size: draft });
      await saved();
    } catch (failure) {
      preview(size);
      setError((failure as Error).message || 'No se pudo guardar el tamaño.');
    }
  };
  const choose = async (file: File) => {
    setError('');
    if (!accepted.includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError('Elige una imagen PNG, JPEG, WebP o SVG de hasta 10 MB.');
      return;
    }
    setBusy(true);
    try {
      await upload('branding/logo', await prepareLogo(file));
      await saved();
      notify('Logo guardado. Ya aparece como marca de agua en el fondo.');
    } catch (failure) {
      setError((failure as Error).message || 'No se pudo guardar el logo.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="gym-logo-setting" aria-labelledby="gym-logo-title">
      <h3 id="gym-logo-title">Logo del gimnasio</h3>
      <p className="helper">
        Se muestra como marca de agua tenue en el fondo de la aplicación y de las credenciales. Funciona mejor un PNG o
        SVG con fondo transparente.
      </p>
      <div className="gym-logo-row">
        <div className="gym-logo-preview">
          {logoPath ? <ScopedImage src={logoUrl(logoPath)} alt={'Logo de ' + name} /> : <span>Sin logo</span>}
        </div>
        <label className={'btn secondary image-upload ' + (busy ? 'disabled' : '')}>
          <ImageUp size={18} /> {busy ? 'Subiendo…' : logoPath ? 'Cambiar logo' : 'Subir logo'}
          <input
            type="file"
            accept={accepted.join(',')}
            aria-label="Subir logo del gimnasio"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void choose(file);
            }}
          />
        </label>
      </div>
      {logoPath && (
        <div className="field gym-logo-size">
          <label htmlFor="gym-logo-size">Tamaño de la marca de agua</label>
          <div className="gym-logo-size-control">
            <input
              id="gym-logo-size"
              type="range"
              min={10}
              max={100}
              step={5}
              value={draft}
              onChange={(event) => preview(Number(event.target.value))}
              onPointerUp={() => void saveSize()}
              onKeyUp={() => void saveSize()}
              onBlur={() => void saveSize()}
            />
            <output htmlFor="gym-logo-size">{draft} %</output>
          </div>
          <small>Arrastra para ver el cambio en el fondo; se guarda al soltar.</small>
        </div>
      )}
      {error && (
        <p className="gym-logo-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
