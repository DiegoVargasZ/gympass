import { WebSocket } from 'ws';

// No inicia sesión ni modifica datos: espera el rechazo del manejador de Upgrade.
const base = new URL(process.argv[2] || 'https://gympass.site');
const url = new URL('/api/gyms/00000000-0000-0000-0000-000000000000/realtime', base);
url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url, ['gympass.v1'], { headers: { Origin: base.origin }, handshakeTimeout: 10000 });
let finished = false;
const finish = (ok, message) => {
  if (finished) return;
  finished = true;
  console.log(message);
  process.exitCode = ok ? 0 : 1;
  socket.terminate();
};
socket.on('unexpected-response', (_req, response) => {
  response.resume();
  const reached = response.statusCode === 401 && response.headers['x-gympass-realtime'] === 'websocket';
  finish(reached, reached
    ? 'WebSocket: el hosting entrega Upgrade al servidor y este exige autenticación correctamente.'
    : `WebSocket: Upgrade no llega al manejador esperado (HTTP ${response.statusCode}). Revisa el proxy del hosting.`);
});
socket.on('open', () => finish(false, 'Error: se aceptó una conexión sin sesión.'));
socket.on('error', error => finish(false, 'WebSocket: ' + error.message));
