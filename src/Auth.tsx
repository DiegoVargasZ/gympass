import { ArrowRight, ShieldCheck, ScanLine, Users, LockKeyhole } from 'lucide-react';
import { Form, Field } from './ui';
import { api } from './api';
import { logoUrl } from './branding';
import ScopedImage from './ScopedImage';
import type { Settings } from '../lib/domain';
import { useState } from 'react';
import RecoverAccount from './RecoverAccount';
import BrandLogo from './BrandLogo';
import AppDownloads from './AppDownloads';
import ServerAccessLink from './ServerAccessLink';
import ConnectionStatus from './ConnectionStatus';
export default function Auth({
  setup,
  onSuccess,
  branding,
}: {
  setup: boolean;
  onSuccess: () => Promise<void>;
  branding?: Pick<Settings, 'name' | 'logo_path'> | null;
}) {
  const [recover, setRecover] = useState(false);
  const [recovered, setRecovered] = useState(false);
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <a className="brand" href="#">
          <BrandLogo />
        </a>
        {branding?.logo_path && (
          <div className="auth-organization">
            <ScopedImage
              className="organization-logo"
              src={logoUrl(branding.logo_path)}
              alt={'Logo de ' + branding.name}
            />
            <span>{branding.name}</span>
          </div>
        )}
        <div className="auth-copy">
          <h1>
            Tu gimnasio.
            <br />
            Cada visita cuenta.
          </h1>
          <p>
            Entradas, salidas y tiempo de entrenamiento.
            <br />
            Consulta quién está dentro y desde qué hora.
          </p>
          <div className="auth-features">
            <span>
              <ScanLine size={18} /> Credenciales QR
            </span>
            <span>
              <Users size={18} /> Tiempo en el gimnasio
            </span>
          </div>
        </div>
        <p className="auth-foot">GymPASS /ACCESO AL GIMNASIO</p>
      </section>
      <main className="auth-main">
        <div className="auth-card">
          <ConnectionStatus />
          <span className="auth-icon">
            <LockKeyhole size={24} />
          </span>
          <span className="eyebrow">{setup ? 'PRIMEROS PASOS' : 'TU ESPACIO DE TRABAJO'}</span>
          <h2>{setup ? 'Prepara tu gimnasio' : 'Te damos la bienvenida'}</h2>
          <p>
            {setup
              ? 'Crea la cuenta que administrará tu sistema de acceso.'
              : 'Inicia sesión para registrar entradas y salidas del gimnasio.'}
          </p>
          <Form
            label={setup ? 'Configurar gimnasio' : 'Iniciar sesión'}
            onSubmit={async (form) => {
              await api('auth/' + (setup ? 'setup' : 'login'), 'POST', {
                ...Object.fromEntries(form),
                remember: form.has('remember'),
              });
              await onSuccess();
            }}
          >
            {setup && (
              <>
                <Field label="Tu nombre">
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="Nombre y apellido"
                  />
                </Field>
                <Field label="Nombre del gimnasio">
                  <input
                    name="organization"
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="Nombre de tu gimnasio"
                  />
                </Field>
              </>
            )}
            <Field label="Correo electrónico">
              <input type="email" name="email" autoComplete="username" required placeholder="nombre@empresa.com" />
            </Field>
            <Field label="Contraseña" hint={setup ? 'Usa al menos 6 caracteres.' : undefined}>
              <input
                type="password"
                name="password"
                required
                minLength={setup ? 6 : 1}
                maxLength={200}
                autoComplete={setup ? 'new-password' : 'current-password'}
                placeholder={setup ? 'Crea una contraseña segura' : 'Tu contraseña'}
              />
            </Field>
            <label className="check-inline">
              <input type="checkbox" name="remember" defaultChecked /> Mantener sesión durante 30 días
            </label>
          </Form>
          {!setup && (
            <>
              <button type="button" className="text-btn" onClick={() => setRecover(true)}>
                Olvidé mi contraseña
              </button>
              {recovered && (
                <p role="status">
                  Contraseña restablecida. Inicia sesión con tu nueva contraseña y genera otra clave de recuperación.
                </p>
              )}
            </>
          )}
          <ServerAccessLink />
          {recover && (
            <RecoverAccount
              onClose={() => setRecover(false)}
              onDone={() => {
                setRecover(false);
                setRecovered(true);
              }}
            />
          )}
          {!window.isSecureContext && (
            <a className="btn secondary" href="/conectar" style={{ width: '100%', marginTop: 16 }}>
              Conectar cámara del teléfono
            </a>
          )}
          <div className="auth-note">
            <ShieldCheck size={16} />
            <span>
              {setup
                ? 'Tus datos se guardan en la base de datos de este servidor.'
                : 'Acceso reservado a usuarios autorizados.'}
            </span>
          </div>
          <AppDownloads />
        </div>
        <p className="auth-bottom">
          Menos fricción. Más tranquilidad. <ArrowRight size={15} />
        </p>
      </main>
    </div>
  );
}
