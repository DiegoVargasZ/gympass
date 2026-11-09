import { useSyncExternalStore } from 'react';
import { ScanGate } from '../lib/scan-gate';

const reader = new ScanGate();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const notify = () => listeners.forEach((listener) => listener());
export function scanSeconds() {
  return reader.seconds();
}
export function claimScan() {
  if (!reader.start()) throw Error(`Espera ${scanSeconds()} s antes de escanear otra credencial.`);
  notify();
}
export function useScanCooldown() {
  return useSyncExternalStore(subscribe, scanSeconds, () => 0);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ||= setInterval(notify, 200);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
