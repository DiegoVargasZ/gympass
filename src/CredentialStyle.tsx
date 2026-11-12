import { useEffect, useState } from 'react';
import { api } from './api';
import { inlineLogo } from './card-download';
import { cardDataUri, cardHeaderAllowed, defaultCardHeader } from '../lib/card';

const colors = [
  { name: 'GymPASS', color: defaultCardHeader },
  { name: 'Negro', color: '#111111' },
  { name: 'Verde oliva', color: '#636b2f' },
  { name: 'Azul', color: '#2455a4' },
  { name: 'Bosque', color: '#356653' },
  { name: 'Ciruela', color: '#75516f' },
  { name: 'Terracota', color: '#9a533f' },
  { name: 'Grafito', color: '#515e6d' },
];

/** Color de la franja y tamaño de la marca de agua de las credenciales, con una tarjeta de ejemplo. */
export default function CredentialStyle({
  name,
  logoPath,
  color: savedColor,
  size: savedSize,
  saved,
}: {
  name: string;
  logoPath: string | null;
  color: string | null;
  size: number;
  saved: () => Promise<void>;
}) {
  const current = savedColor || defaultCardHeader;
  const [color, setColor] = useState(current);
  const [size, setSize] = useState(savedSize);
  const [logo, setLogo] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setColor(current), [current]);
  useEffect(() => setSize(savedSize), [savedSize]);
  useEffect(() => {
    let live = true;
    setLogo(null);
    if (logoPath) void inlineLogo(logoPath).then((value) => live && setLogo(value));
    return () => {
      live = false;
    };
  }, [logoPath]);
  const allowed = cardHeaderAllowed(color);
  const save = async (change: { credential_color?: string; credential_watermark_size?: number }) => {
    setError('');
    try {
      await api('settings', 'PATCH', change);
      await saved();
    } catch (failure) {
      setColor(current);
      setSize(savedSize);
      setError((failure as Error).message || 'No se pudo guardar el cambio.');
    }
  };
  const saveColor = (value: string) => {
    const next = value.toLowerCase();
    setColor(next);
    if (!cardHeaderAllowed(next)) {
      setError('Ese color es demasiado claro para el logotipo blanco de la credencial. Elige uno más oscuro.');
      return;
    }
    if (next !== current) void save({ credential_color: next });
    else setError('');
  };
  const saveSize = () => {
    if (size !== savedSize) void save({ credential_watermark_size: size });
  };
  return (
    <section className="credential-style" aria-labelledby="credential-style-title">
      <h3 id="credential-style-title">Credenciales</h3>
      <p className="helper">Así se ven las credenciales que descargas, imprimes o compartes.</p>
      <div className="credential-style-layout">
        <img
          className="credential-style-preview"
          alt="Ejemplo de credencial"
          src={cardDataUri({
            name: 'María Pérez',
            document: '1234567',
            subtitle: 'Socio',
            organization: name,
            code: 'GYMPASS-EJEMPLO',
            expires: null,
            access_note: 'Acceso según el plan vigente',
            label: 'Credencial permanente',
            accent: allowed ? color : current,
            header: allowed ? color : current,
            watermark: logo,
            watermark_size: size,
          })}
        />
        <div className="credential-style-controls">
          <fieldset className="gym-card-color">
            <legend>Color de la credencial</legend>
            <div className="gym-card-color-options">
              {colors.map((option) => (
                <button
                  key={option.color}
                  type="button"
                  className="gym-card-swatch"
                  style={{ background: option.color }}
                  aria-label={option.name}
                  title={option.name}
                  aria-pressed={color === option.color}
                  onClick={() => saveColor(option.color)}
                />
              ))}
            </div>
            <label className="gym-card-custom">
              Otro color
              <input
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                onBlur={(event) => saveColor(event.target.value)}
              />
            </label>
          </fieldset>
          {logoPath ? (
            <div className="field gym-logo-size">
              <label htmlFor="credential-watermark-size">Tamaño de la marca de agua en la credencial</label>
              <div className="gym-logo-size-control">
                <input
                  id="credential-watermark-size"
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={size}
                  onChange={(event) => setSize(Number(event.target.value))}
                  onPointerUp={saveSize}
                  onKeyUp={saveSize}
                  onBlur={saveSize}
                />
                <output htmlFor="credential-watermark-size">{size} %</output>
              </div>
              <small>Se guarda al soltar el control.</small>
            </div>
          ) : (
            <p className="helper">Sube el logo del gimnasio para añadirlo como marca de agua.</p>
          )}
          {error && (
            <p className="gym-logo-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
