import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { requestToken } from './platform-http.ts';
import type { PlatformStore } from './platform-store.ts';

export type ChangeTopic = 'access' | 'people' | 'pos' | 'settings' | 'alerts' | 'time';
type Client = { socket: WebSocket; gym: string; token: string; support?: string; role: string; alive: boolean };

export function createRealtime(server: Server, store: PlatformStore, publicOrigin?: string) {
  const clients = new Set<Client>();
  const pending = new Map<string, Set<ChangeTopic>>();
  const revisions = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('gympass.v1') ? 'gympass.v1' : false),
  });
  const authorized = (client: Client) => {
    try {
      const auth = store.authorizeSync(client.token, client.gym, client.support);
      if (auth.actor.role !== client.role) throw Error('Permisos modificados');
      return true;
    } catch {
      client.socket.close(4003, 'Vuelve a iniciar sesión.');
      return false;
    }
  };
  const send = (client: Client, value: unknown) => {
    if (client.socket.readyState !== WebSocket.OPEN || !authorized(client)) return;
    if (client.socket.bufferedAmount > 65536) return client.socket.terminate();
    client.socket.send(JSON.stringify(value), (error) => {
      if (error) client.socket.terminate();
    });
  };
  const flush = () => {
    flushTimer = undefined;
    for (const [gym, topics] of pending) {
      if (![...clients].some((client) => client.gym === gym)) continue;
      const revision = (revisions.get(gym) || 0) + 1;
      revisions.set(gym, revision);
      for (const client of clients)
        if (client.gym === gym) send(client, { type: 'change', topics: [...topics], revision });
    }
    pending.clear();
  };
  const reject = (socket: Duplex, status: number) => {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nX-GymPASS-Realtime: websocket\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    if (closed) return reject(socket, 503);
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return reject(socket, 400);
    }
    const match = /^\/api\/gyms\/([a-f\d-]{36})\/realtime$/.exec(url.pathname);
    if (!match) return reject(socket, 404);
    const expected = publicOrigin || `http://${req.headers.host}`;
    if (req.headers.origin !== expected || req.headers.authorization) return reject(socket, 403);
    const protocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((p) => p.trim());
    if (!protocols.includes('gympass.v1') || protocols.length > 2) return reject(socket, 400);
    const support = protocols.find((p) => p.startsWith('support.'))?.slice(8);
    if (support && !/^[a-f\d]{64}$/.test(support)) return reject(socket, 400);
    try {
      const token = requestToken(req);
      if (store.authenticateSync(token)?.mobileGymId) return reject(socket, 403);
      const auth = store.authorizeSync(token, match[1], support);
      if (clients.size >= 2048 || [...clients].filter((c) => c.token === token).length >= 12)
        return reject(socket, 429);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: Client = { socket: ws, gym: match[1], token, support, role: auth.actor.role, alive: true };
        clients.add(client);
        ws.on('error', () => {});
        ws.on('pong', () => {
          client.alive = true;
        });
        ws.on('message', () => ws.close(1008, 'Esta conexión recibe avisos de cambios.'));
        ws.on('close', () => {
          clients.delete(client);
          if (![...clients].some((c) => c.gym === client.gym)) revisions.delete(client.gym);
        });
        send(client, { type: 'ready', protocol: 1, revision: revisions.get(client.gym) || 0 });
      });
    } catch {
      reject(socket, 401);
    }
  };
  server.on('upgrade', upgrade);
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive || client.socket.readyState !== WebSocket.OPEN) {
        client.socket.terminate();
        continue;
      }
      if (!authorized(client)) continue;
      client.alive = false;
      client.socket.ping();
    }
  }, 25000);
  heartbeat.unref();
  return {
    publish(gym: string, topics: ChangeTopic[]) {
      if (closed || ![...clients].some((c) => c.gym === gym)) return;
      const changes = pending.get(gym) || new Set<ChangeTopic>();
      topics.forEach((topic) => changes.add(topic));
      pending.set(gym, changes);
      flushTimer ||= setTimeout(flush, 80);
    },
    revalidate() {
      for (const client of clients) authorized(client);
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      pending.clear();
      server.off('upgrade', upgrade);
      for (const client of clients) client.socket.terminate();
      clients.clear();
      wss.close();
    },
  };
}

export function changeTopics(resource: string): ChangeTopic[] {
  if (resource === 'access' || resource === 'device-access' || resource === 'gym-sessions') return ['access', 'alerts'];
  if (resource === 'pos') return ['pos', 'people', 'alerts'];
  if (resource === 'alerts') return ['alerts'];
  if (resource === 'people' || resource === 'credentials') return ['people', 'alerts'];
  return ['settings', 'people', 'access', 'pos', 'alerts'];
}
