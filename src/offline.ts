import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { AccessEvent, Bootstrap } from '../lib/domain';
import {
  OfflineAccessQueue,
  type QueueCapture,
  type QueueIdentity,
  type QueuedAccess,
  type StoredAccess,
} from './offline-queue';

export type { QueuedAccess } from './offline-queue';
const databaseName = 'gympass-offline';
const storeName = 'access-queue';
let connection: Promise<IDBDatabase | null> | null = null;

function open() {
  connection ||= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (!globalThis.indexedDB) return resolve(null);
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName, { keyPath: 'request_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return connection;
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      request.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function insert(record: QueuedAccess) {
  const db = await open();
  if (!db) return null;
  return new Promise<StoredAccess | null>((resolve) => {
    try {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.get(record.request_id);
      let result: StoredAccess;
      request.onsuccess = () => {
        if (request.result) result = request.result as StoredAccess;
        else {
          result = record;
          store.add(record);
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => resolve(null);
      transaction.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const queue = new OfflineAccessQueue(
  {
    async list() {
      return (await transact<StoredAccess[]>('readonly', (store) => store.getAll())) || [];
    },
    insert,
    async remove(requestId) {
      const result = await transact('readwrite', (store) => store.delete(requestId));
      if (result === null)
        throw new Error(
          'El movimiento se envió, pero la cola local no pudo actualizarse. Se comprobará al reintentar.',
        );
    },
    async update(requestId, identity, changes) {
      const db = await open();
      if (!db) throw new Error('No se puede actualizar la cola local en este navegador.');
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.get(requestId);
        let message = 'No se pudo guardar la revisión del movimiento.';
        request.onsuccess = () => {
          const record = request.result as StoredAccess | undefined;
          if (!record || record.installation_id !== identity.installation_id || record.actor_id !== identity.actor_id) {
            message = 'El movimiento no pertenece a esta sesión.';
            transaction.abort();
            return;
          }
          store.put({ ...record, ...changes });
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error(message));
        transaction.onerror = () => reject(new Error(message));
      });
    },
  },
  (body, signal) => api<AccessEvent>('access', 'POST', body, signal),
);

export function accessQueueIdentity(data: Bootstrap): QueueIdentity {
  return { installation_id: data.installation_id, actor_id: data.user.id, role: data.user.role };
}
export function setAccessQueueIdentity(identity: QueueIdentity | null) {
  return queue.setIdentity(identity);
}
export function captureAccessIdentity(identity: QueueIdentity) {
  return queue.capture(identity);
}
export function enqueueAccess(record: QueuedAccess, capture: QueueCapture) {
  return queue.enqueue(record, capture);
}
export function flushAccessQueue() {
  return queue.flush();
}
export function reviewAccessQueue() {
  return queue.reviewRecords();
}
export function setAccessReview(requestId: string, held: boolean) {
  return queue.setReview(requestId, held);
}
export function startOfflineQueue() {
  void queue.refresh();
  const retry = () => void flushAccessQueue().catch(() => {});
  window.addEventListener('online', retry);
  const timer = setInterval(() => {
    if (queue.snapshot().pending && !queue.snapshot().sending && navigator.onLine !== false) retry();
  }, 20000);
  return () => {
    window.removeEventListener('online', retry);
    clearInterval(timer);
  };
}
export function useAccessQueue() {
  return useSyncExternalStore(queue.subscribe, queue.snapshot, queue.snapshot);
}
