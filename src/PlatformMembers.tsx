import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Pencil, Plus } from 'lucide-react';
import { api } from './api';
import { Empty, Field, Form, Modal, Skeleton } from './ui';

type Role = 'admin' | 'operator' | 'viewer';
type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean | number;
  can_reset_password?: boolean;
};
type SharedLink = { token: string; email?: string; expires_at: number };
const roles: Record<Role, string> = { admin: 'Administrador', operator: 'Cajero', viewer: 'Consulta' };

export default function PlatformMembers({
  gymId,
  superadmin = false,
  currentUserId,
}: {
  gymId: string;
  superadmin?: boolean;
  currentUserId?: string;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [member, setMember] = useState<Member | 'new' | null>(null);
  const [passwordMember, setPasswordMember] = useState<Member | null>(null);
  const [shared, setShared] = useState<SharedLink | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recovering, setRecovering] = useState<string | null>(null);
  const sequence = useRef(0);
  const path = 'platform/gyms/' + encodeURIComponent(gymId);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await api<{ members: Member[] }>(path + '/members');
      if (current !== sequence.current) return;
      setMembers(result.members);
      setError('');
    } catch (cause) {
      if (current === sequence.current) setError((cause as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setMembers(null);
    setShared(null);
    setMember(null);
    setPasswordMember(null);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [gymId]);
  const current = member && member !== 'new' ? member : null;
  const link = shared ? location.origin + location.pathname + '#recover=' + encodeURIComponent(shared.token) : '';

  return (
    <div className="platform-members">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Personal del gimnasio</h2>
            <p>Administrador: gestión completa · Cajero: recepción, socios y caja · Consulta: solo lectura</p>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              setMember('new');
              setShared(null);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Crear usuario
          </button>
        </div>
        {error && (
          <div className="error-message" role="alert">
            {error}
            <button className="text-btn" onClick={() => void refresh()}>
              Reintentar
            </button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {!members && !error && <Skeleton rows={3} label="Cargando usuarios" />}
        {members &&
          (!members.length ? (
            <Empty text="Crea las cuentas del personal que trabaja en este gimnasio." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Rol</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <small>{item.email}</small>
                      </td>
                      <td>{roles[item.role]}</td>
                      <td>{item.active ? 'Activo' : 'Deshabilitado'}</td>
                      <td>
                        <div className="platform-actions">
                          <button
                            className="icon-btn"
                            aria-label={'Editar ' + item.name}
                            onClick={() => setMember(item)}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </button>
                          {item.can_reset_password && item.id !== currentUserId && (
                            <button
                              className="btn secondary"
                              aria-label={'Cambiar contraseña de ' + item.name}
                              onClick={() => {
                                setPasswordMember(item);
                                setShared(null);
                              }}
                            >
                              <KeyRound size={16} aria-hidden="true" /> Cambiar contraseña
                            </button>
                          )}
                          {superadmin && !item.can_reset_password && (
                            <button
                              className="btn secondary"
                              disabled={recovering !== null}
                              onClick={async () => {
                                setRecovering(item.id);
                                setError('');
                                try {
                                  const result = await api<{ token: string; expires_at: number }>(
                                    'platform/users/' + encodeURIComponent(item.id) + '/recovery',
                                    'POST',
                                  );
                                  setShared({ ...result, email: item.email });
                                } catch (cause) {
                                  setError((cause as Error).message);
                                } finally {
                                  setRecovering(null);
                                }
                              }}
                            >
                              <KeyRound size={16} aria-hidden="true" />
                              {recovering === item.id ? 'Preparando…' : 'Recuperar cuenta'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>
      {shared && (
        <section className="panel platform-invitation" aria-label="Enlace preparado">
          <h2>Recuperación preparada</h2>
          <p>
            Comparte este enlace de un solo uso con {shared.email}. La persona elige una nueva contraseña; las sesiones
            anteriores se cierran.
          </p>
          <Field label="Enlace de recuperación">
            <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <p className="helper">Vence: {new Date(shared.expires_at).toLocaleString()}</p>
          <button
            className="btn secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setNotice('Enlace copiado.');
              } catch {
                setNotice('Selecciona y copia el enlace del campo.');
              }
            }}
          >
            Copiar enlace
          </button>
        </section>
      )}
      {member && (
        <Modal title={current ? 'Editar personal' : 'Crear usuario'} onClose={() => setMember(null)}>
          <Form
            label={current ? 'Guardar permisos' : 'Crear usuario'}
            onCancel={() => setMember(null)}
            onSubmit={async (form) => {
              if (current) {
                await api(path + '/members/' + encodeURIComponent(current.id), 'PATCH', {
                  role: form.get('role'),
                  active: form.get('active') === '1',
                });
                await refresh();
              } else {
                const { password_confirmation, ...input } = Object.fromEntries(form);
                if (input.password !== password_confirmation) throw Error('Las contraseñas no coinciden.');
                await api(path + '/members', 'POST', input);
                setNotice('Usuario creado. Ya puede iniciar sesión con su correo y contraseña.');
                await refresh();
              }
              setMember(null);
            }}
          >
            {current ? (
              <p>
                <strong>{current.name}</strong>
                <br />
                {current.email}
              </p>
            ) : (
              <>
                <Field label="Nombre">
                  <input name="name" maxLength={120} required />
                </Field>
                <Field label="Correo electrónico">
                  <input name="email" type="email" maxLength={254} required />
                </Field>
                <Field label="Contraseña" hint="Entre 6 y 200 caracteres. Entrégala al usuario para su primer acceso.">
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={6}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field label="Repetir contraseña">
                  <input
                    name="password_confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={6}
                    maxLength={200}
                    required
                  />
                </Field>
              </>
            )}
            <Field label="Rol">
              <select name="role" defaultValue={current?.role || 'operator'}>
                {Object.entries(roles).map(([role, label]) => (
                  <option key={role} value={role}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {current && (
              <Field label="Estado">
                <select name="active" defaultValue={current.active ? '1' : '0'}>
                  <option value="1">Activo</option>
                  <option value="0">Deshabilitado</option>
                </select>
              </Field>
            )}
            <p className="helper">Cada gimnasio debe conservar al menos un administrador activo.</p>
          </Form>
        </Modal>
      )}
      {passwordMember && (
        <Modal title={'Cambiar contraseña de ' + passwordMember.name} onClose={() => setPasswordMember(null)}>
          <Form
            label="Guardar contraseña"
            onCancel={() => setPasswordMember(null)}
            onSubmit={async (form) => {
              const password = form.get('password');
              if (password !== form.get('password_confirmation')) throw Error('Las contraseñas no coinciden.');
              await api(path + '/members/' + encodeURIComponent(passwordMember.id) + '/password', 'POST', { password });
              setPasswordMember(null);
              setNotice('Contraseña actualizada. El usuario debe iniciar sesión de nuevo.');
            }}
          >
            <p>
              Se cerrarán las sesiones de {passwordMember.name}. Entrégale la nueva contraseña para volver a entrar.
            </p>
            <Field label="Nueva contraseña" hint="Entre 6 y 200 caracteres.">
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={200}
                required
              />
            </Field>
            <Field label="Repetir contraseña">
              <input
                name="password_confirmation"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={200}
                required
              />
            </Field>
          </Form>
        </Modal>
      )}
    </div>
  );
}
