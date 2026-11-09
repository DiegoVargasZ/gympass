import { HttpError, NetworkError } from './api.ts';
import { reasons, type AccessEvent, type Role } from '../lib/domain.ts';

export type QueueIdentity = { installation_id: string; actor_id: string; role: Role };
export type QueuedAccess = {
  request_id: string;
  installation_id: string;
  actor_id: string;
  zone_id: string;
  zone_name: string;
  direction: string;
  code?: string;
  person_id?: string;
  person_name?: string;
  reason?: string;
  queued_at: number;
  attempts: number;
  last_error?: string;
  review_required?: boolean;
};
export type StoredAccess = Omit<QueuedAccess, 'installation_id' | 'actor_id'> &
  Partial<Pick<QueuedAccess, 'installation_id' | 'actor_id'>>;
export type QueueStore = {
  list(): Promise<StoredAccess[]>;
  insert(record: QueuedAccess): Promise<StoredAccess | null>;
  remove(requestId: string): Promise<void>;
  update(
    requestId: string,
    identity: QueueIdentity,
    changes: Partial<Pick<QueuedAccess, 'review_required' | 'last_error' | 'attempts'>>,
  ): Promise<void>;
};
type ReplayBody = {
  request_id: string;
  zone_id: string;
  direction: string;
  expected_actor_id: string;
  expected_installation_id: string;
  code?: string;
  person_id?: string;
  reason?: string;
};
type ReplayResult = Pick<AccessEvent, 'allowed' | 'person_name' | 'reason'>;
type Send = (body: ReplayBody, signal: AbortSignal) => Promise<ReplayResult>;
export type QueueCapture = { identity: QueueIdentity; generation: number };
export type QueueState = {
  pending: number;
  held: number;
  blocked: number;
  legacy: number;
  sending: boolean;
  lastError: string;
};
type FlushResult = { sent: number; failed: number };

function ownedBy(record: StoredAccess, identity: QueueIdentity | null) {
  return !!identity && record.installation_id === identity.installation_id && record.actor_id === identity.actor_id;
}
function canWrite(identity: QueueIdentity | null) {
  return !!identity?.installation_id && !!identity.actor_id && ['admin', 'operator'].includes(identity.role);
}
function sameIdentity(a: QueueIdentity | null, b: QueueIdentity | null) {
  return a?.installation_id === b?.installation_id && a?.actor_id === b?.actor_id && a?.role === b?.role;
}
function sameMovement(a: StoredAccess, b: QueuedAccess) {
  return (
    ownedBy(a, { ...b, role: 'operator' }) &&
    a.zone_id === b.zone_id &&
    a.direction === b.direction &&
    a.code === b.code &&
    a.person_id === b.person_id &&
    a.reason === b.reason
  );
}

export class OfflineAccessQueue {
  private store: QueueStore;
  private send: Send;
  private identity: QueueIdentity | null = null;
  private generation = 0;
  private state: QueueState = { pending: 0, held: 0, blocked: 0, legacy: 0, sending: false, lastError: '' };
  private reviewing = false;
  private listeners = new Set<() => void>();
  private active: { generation: number; controller: AbortController; promise: Promise<FlushResult> } | null = null;

  constructor(store: QueueStore, send: Send) {
    this.store = store;
    this.send = send;
  }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  private emit(change: Partial<QueueState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  async refresh() {
    const generation = this.generation;
    const rows = await this.store.list();
    if (generation !== this.generation) return;
    const owned = rows.filter((row) => ownedBy(row, this.identity));
    const held = owned.filter((row) => row.review_required).length;
    this.emit({
      pending: owned.length - held,
      held: canWrite(this.identity) ? held : 0,
      blocked: rows.length - (canWrite(this.identity) ? owned.length : 0),
      legacy: rows.filter((row) => !row.installation_id || !row.actor_id).length,
    });
  }
  setIdentity(identity: QueueIdentity | null) {
    if (!sameIdentity(this.identity, identity)) {
      this.generation++;
      this.active?.controller.abort();
      this.identity = identity ? { ...identity } : null;
      this.emit({ pending: 0, held: 0, blocked: 0, legacy: 0, sending: false, lastError: '' });
    }
    return this.refresh();
  }
  capture(identity: QueueIdentity): QueueCapture {
    if (!canWrite(identity)) throw new Error('Esta cuenta no tiene permiso para registrar movimientos.');
    if (!sameIdentity(identity, this.identity))
      throw new Error('La sesión cambió. Actualiza los datos antes de registrar.');
    return { identity: { ...identity }, generation: this.generation };
  }
  private current(capture: QueueCapture) {
    return (
      capture.generation === this.generation && sameIdentity(capture.identity, this.identity) && canWrite(this.identity)
    );
  }
  async enqueue(record: QueuedAccess, capture: QueueCapture) {
    if (!this.current(capture) || !ownedBy(record, capture.identity))
      throw new Error('La sesión cambió. El movimiento no se guardó en la cola de otra cuenta.');
    // An existing request is immutable, including legacy rows whose owner is unknown.
    const saved = await this.store.insert(record);
    if (saved && !sameMovement(saved, record))
      throw new Error('Este identificador ya pertenece a otro movimiento pendiente.');
    await this.refresh();
    return saved as QueuedAccess | null;
  }
  async reviewRecords(): Promise<StoredAccess[]> {
    if (!canWrite(this.identity)) return [];
    const capture = this.capture(this.identity!);
    const rows = await this.store.list();
    if (!this.current(capture)) return [];
    return rows.filter((row) => ownedBy(row, capture.identity)).sort((a, b) => a.queued_at - b.queued_at);
  }
  async setReview(requestId: string, held: boolean) {
    if (!canWrite(this.identity)) throw new Error('Esta cuenta no tiene permiso para revisar movimientos.');
    if (this.active || this.state.sending || this.reviewing)
      throw new Error('Espera a que termine el envío o la revisión actual.');
    const capture = this.capture(this.identity!);
    this.reviewing = true;
    try {
      const record = (await this.store.list()).find((row) => row.request_id === requestId);
      if (!this.current(capture)) throw new Error('La sesión cambió. Abre de nuevo la revisión.');
      if (!record || !ownedBy(record, capture.identity)) throw new Error('El movimiento no pertenece a esta sesión.');
      await this.store.update(requestId, capture.identity, { review_required: held });
      if (this.current(capture)) this.emit({ lastError: '' });
    } finally {
      this.reviewing = false;
      await this.refresh();
    }
  }
  flush(): Promise<FlushResult> {
    if (this.reviewing) return Promise.resolve({ sent: 0, failed: 0 });
    if (this.active) {
      if (this.active.generation === this.generation) return this.active.promise;
      return this.active.promise.then(() => this.flush());
    }
    if (!canWrite(this.identity)) return this.refresh().then(() => ({ sent: 0, failed: 0 }));
    const capture = this.capture(this.identity!);
    const controller = new AbortController();
    const promise = this.replay(capture, controller.signal).finally(() => {
      this.active = null;
    });
    this.active = { generation: capture.generation, controller, promise };
    return promise;
  }
  private async replay(capture: QueueCapture, signal: AbortSignal) {
    let sent = 0,
      failed = 0;
    this.emit({ sending: true, lastError: '' });
    try {
      const rows = (await this.store.list()).sort((a, b) => a.queued_at - b.queued_at);
      for (const record of rows) {
        if (!this.current(capture)) break;
        if (!ownedBy(record, capture.identity) || record.review_required) continue;
        const body: ReplayBody = {
          request_id: record.request_id,
          zone_id: record.zone_id,
          direction: record.direction,
          expected_actor_id: capture.identity.actor_id,
          expected_installation_id: capture.identity.installation_id,
          ...(record.code ? { code: record.code } : {}),
          ...(record.person_id ? { person_id: record.person_id } : {}),
          ...(record.reason ? { reason: record.reason } : {}),
        };
        try {
          const event = await this.send(body, signal);
          await this.store.remove(record.request_id);
          if (event.allowed) sent++;
          else {
            failed++;
            if (this.current(capture))
              this.emit({ lastError: `${event.person_name}: ${reasons[event.reason] || event.reason}` });
          }
        } catch (error) {
          if (!this.current(capture) || signal.aborted) break;
          await this.store.update(record.request_id, capture.identity, {
            attempts: (record.attempts || 0) + 1,
            last_error: (error as Error).message,
          });
          if (!this.current(capture)) break;
          if (error instanceof NetworkError) break;
          failed++;
          this.emit({
            lastError:
              error instanceof HttpError && error.status === 401
                ? 'Inicia sesión con la cuenta que capturó estos movimientos para reenviarlos.'
                : error instanceof HttpError && error.status === 403
                  ? 'La sesión no tiene permiso para reenviar estos movimientos. Se conservaron en este navegador.'
                  : (error as Error).message,
          });
          // Only a final access decision removes a record; transport and permission errors retain it.
          break;
        }
      }
    } finally {
      await this.refresh();
      if (this.current(capture)) this.emit({ sending: false });
    }
    return { sent, failed };
  }
}
