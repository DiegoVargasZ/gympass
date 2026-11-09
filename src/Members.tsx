import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { type Member, roleLabels } from '../lib/domain';
import { Badge, Field, Form, Modal } from './ui';
import { api } from './api';

export default function Members({ members, saved }: { members: Member[]; saved: () => Promise<void> }) {
  const [member, setMember] = useState<Member | 'new' | null>(null);
  const m = member && member !== 'new' ? member : undefined;
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Personal del gimnasio</h2>
            <p>Administrador: gestión completa · Cajero: recepción, socios y caja · Consulta: solo lectura</p>
          </div>
          <button className="btn primary" onClick={() => setMember('new')}>
            <Plus size={16} /> Nuevo personal
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {members.map((item) => (
                <tr key={item.email}>
                  <td>
                    <strong>{item.name}</strong>
                    <small>{item.email}</small>
                  </td>
                  <td>{roleLabels[item.role]}</td>
                  <td>
                    <Badge tone={item.active ? 'green' : 'gray'}>{item.active ? 'Activo' : 'Deshabilitado'}</Badge>
                  </td>
                  <td>
                    <button className="icon-btn" aria-label={'Editar ' + item.name} onClick={() => setMember(item)}>
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {member && (
        <Modal title={m ? 'Editar personal' : 'Nuevo personal'} onClose={() => setMember(null)}>
          <Form
            onCancel={() => setMember(null)}
            onSubmit={async (f) => {
              await api('members', 'POST', { ...Object.fromEntries(f), active: Number(f.get('active')) });
              await saved();
              setMember(null);
            }}
          >
            <Field label="Nombre">
              <input name="name" required maxLength={120} defaultValue={m?.name} />
            </Field>
            <Field label="Correo electrónico">
              <input name="email" type="email" required readOnly={!!m} defaultValue={m?.email} />
            </Field>
            <div className="form-grid">
              <Field label="Rol">
                <select name="role" defaultValue={m?.role || 'operator'}>
                  {Object.entries(roleLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Estado">
                <select name="active" defaultValue={m?.active ?? 1}>
                  <option value={1}>Activo</option>
                  <option value={0}>Deshabilitado</option>
                </select>
              </Field>
            </div>
            <Field
              label={m ? 'Nueva contraseña (opcional)' : 'Contraseña'}
              hint="Al menos 6 caracteres. Cambiarla cierra las sesiones existentes."
            >
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required={!m}
                minLength={6}
                maxLength={200}
              />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
