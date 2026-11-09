import { Field, Form, Modal } from './ui';
import { api } from './api';
export default function RecoverAccount({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  return (
    <Modal title="Recuperar acceso del administrador" onClose={onClose}>
      <p>
        Usa la clave de recuperación que guardaste desde Configuración. Al restablecer la contraseña se cerrarán las
        sesiones del administrador y se consumirá la clave.
      </p>
      <Form
        label="Restablecer contraseña"
        onCancel={onClose}
        onSubmit={async (form) => {
          if (form.get('password') !== form.get('confirm')) throw Error('Las contraseñas no coinciden.');
          await api('auth/recover', 'POST', { code: form.get('code'), password: form.get('password') });
          onDone();
        }}
      >
        <Field label="Clave de recuperación">
          <input name="code" autoComplete="off" required maxLength={100} placeholder="GP-REC-…" />
        </Field>
        <Field label="Nueva contraseña" hint="De 6 a 200 caracteres.">
          <input name="password" type="password" autoComplete="new-password" required minLength={6} maxLength={200} />
        </Field>
        <Field label="Repetir nueva contraseña">
          <input name="confirm" type="password" autoComplete="new-password" required minLength={6} maxLength={200} />
        </Field>
      </Form>
    </Modal>
  );
}
