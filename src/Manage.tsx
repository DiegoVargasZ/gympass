import { useEffect, useState } from 'react';
import type { Bootstrap, Device, Member } from '../lib/domain';
import type { AuditEntry } from './management';
import type { Notify } from './ui';
import { api } from './api';
import Settings from './Settings';
type Props = {
  page: 'settings';
  data: Bootstrap;
  reload: () => Promise<void>;
  notify: Notify;
  admin: boolean;
};
export default function Manage({ page, data, reload, notify, admin }: Props) {
  const [members, setMembers] = useState<Member[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [audit, setAudit] = useState<AuditEntry[]>([]),
    [error, setError] = useState('');
  async function loadAdmin() {
    if (!admin || page !== 'settings') return;
    const [m, d, a] = await Promise.all([
      api<Member[]>('members'),
      api<Device[]>('devices'),
      api<AuditEntry[]>('audit'),
    ]);
    setMembers(m);
    setDevices(d);
    setAudit(a);
  }
  useEffect(() => {
    void loadAdmin().catch((e) => setError(e.message));
  }, [page, admin]);
  async function saved() {
    await reload();
    await loadAdmin();
    notify('Cambios guardados');
  }
  const resources = { data, admin, saved };
  return (
    <>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <Settings {...resources} notify={notify} members={members} devices={devices} audit={audit} />
    </>
  );
}
