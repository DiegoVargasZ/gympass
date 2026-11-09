export const SCAN_INTERVAL_MS = 5000;

/** One reader can start a new scan every five seconds, regardless of the QR or selected zone. */
export class ScanGate {
  private readyAt = -Infinity;
  private now: () => number;
  constructor(now = () => performance.now()) {
    this.now = now;
  }
  remaining() {
    return Math.max(0, this.readyAt - this.now());
  }
  seconds() {
    return Math.ceil(this.remaining() / 1000);
  }
  start() {
    if (this.remaining() > 0) return false;
    this.readyAt = this.now() + SCAN_INTERVAL_MS;
    return true;
  }
}
