import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { PlatformStore } from './platform-store.ts';
import { createPlatformApi } from './platform-api.ts';
import { TenantManager } from './tenant-manager.ts';
import { gymApi } from './platform-gym-api.ts';
import { ApiError, Service, hash } from '../lib/service.ts';
import { reasons } from '../lib/domain.ts';
import { json, cookieValue, requestToken, readJson } from './platform-http.ts';
import { acquirePlatformLock } from './platform-lock.ts';
import { staticAsset, staticBytes } from './static-files.ts';
import { authorizedDatabase } from './authorized-database.ts';
import { createRealtime, changeTopics } from './realtime.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
type Options = {
  dataDirectory: string;
  port?: number;
  host?: string;
  publicOrigin?: string;
  allowHttp?: boolean;
  maxOpen?: number;
};

export async function startPlatform(options: Options) {
  const host = options.host || '127.0.0.1';
  const origin = options.publicOrigin?.replace(/\/$/, '');
  if (!options.allowHttp && (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin))
    throw Error('Configura PUBLIC_ORIGIN con el dominio HTTPS de la plataforma.');
  if (options.allowHttp && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw Error('HTTP de prueba solo se permite en la computadora local.');
  const tenants = new TenantManager(options.dataDirectory, { maxOpen: options.maxOpen });
  const unlock = acquirePlatformLock(tenants.root);
  const store = new PlatformStore(options.dataDirectory);
  const platformApi = createPlatformApi(store, {
    provisionGym: async (gym) => {
      tenants.provision(gym);
    },
    secureCookies: !!origin,
  });
  const limits = new Map<string, { count: number; until: number }>();
  let maintenanceWork: Promise<void> | null = null;
  let realtime: ReturnType<typeof createRealtime> | undefined;
  const server = createServer(async (req, res) => {
    res.once('finish', () => {
      if (res.statusCode >= 400 || ['GET', 'HEAD'].includes(req.method || 'GET')) return;
      let route: string;
      try {
        route = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        return;
      }
      const gym = /^\/api\/gyms\/([a-f\d-]{36})\/([^/]+)/.exec(route);
      if (gym && gym[2] !== 'auth' && (gym[2] !== 'backups' || route.endsWith('/restore')))
        realtime?.publish(gym[1], changeTopics(gym[2]));
      if (gym?.[2] === 'auth') realtime?.revalidate();
      if (route.startsWith('/api/platform/')) {
        realtime?.revalidate();
        const changed = /^\/api\/platform\/gyms\/([a-f\d-]{36})/.exec(route);
        if (changed) realtime?.publish(changed[1], ['settings', 'people', 'pos', 'access', 'alerts']);
      }
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${origin ? origin.replace(/^https:/, 'wss:') : `ws://${req.headers.host}`}; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
    if (origin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method || 'GET';
      const writing = !['GET', 'HEAD'].includes(method);
      if (url.pathname.startsWith('/api/')) {
        const expected = origin || `http://${req.headers.host}`;
        if (writing) {
          if (req.headers.origin && req.headers.origin !== expected) throw new ApiError(403, 'Origen no permitido.');
          if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'Solicitud no permitida.');
          const deviceRoute = /^\/api\/gyms\/[a-f\d-]{36}\/device-access$/.test(url.pathname);
          if (!deviceRoute && req.headers['x-requested-with'] !== 'GymPASS')
            throw new ApiError(403, 'Solicitud no permitida.');
        }
        if (/\/(login|mobile-login|accept|password)$/.test(url.pathname) && writing) {
          const key = (req.socket.remoteAddress || 'unknown') + ':' + url.pathname;
          const now = Date.now();
          if (limits.size > 10000) for (const [key, value] of limits) if (value.until < now) limits.delete(key);
          let value = limits.get(key);
          if (!value || value.until < now) {
            value = { count: 0, until: now + 15 * 60000 };
            limits.set(key, value);
          }
          if (++value.count > 30) throw new ApiError(429, 'Demasiados intentos. Espera unos minutos.');
        }
        if (url.pathname === '/api/health' && method === 'GET') {
          res.setHeader('X-GymPASS-Realtime', '1');
          return json(res, { ok: true, mode: 'platform', protocol: 1 });
        }
        if (url.pathname === '/api/platform/backups' && method === 'POST') {
          const requestSession = requestToken(req);
          const session = await store.requireWebSession(requestSession);
          if (session.user.global_role !== 'superadmin') throw new ApiError(403, 'Se requiere superadministrador.');
          const body = await readJson(req);
          await store.requireWebSession(requestSession);
          const row = store.raw.prepare('SELECT password_hash FROM platform_users WHERE id=?').get(session.user.id);
          const { verifyPassword } = await import('./auth.ts');
          if (
            !row ||
            typeof body.password !== 'string' ||
            !(await verifyPassword(body.password, String(row.password_hash)))
          )
            throw new ApiError(403, 'Confirma tu contraseña de superadministrador.');
          const authorize = () => {
            const current = store.authenticateSync(requestSession);
            if (!current || current.mobileGymId) throw new ApiError(401, 'Inicia sesión de nuevo.');
            if (current.user.global_role !== 'superadmin') throw new ApiError(403, 'Se requiere superadministrador.');
            if (
              store.raw.prepare('SELECT password_hash FROM platform_users WHERE id=? AND active=1').get(current.user.id)
                ?.password_hash !== row.password_hash
            )
              throw new ApiError(401, 'Las credenciales cambiaron. Inicia sesión de nuevo.');
          };
          authorize();
          const copy = await tenants.snapshotPlatform(store.raw, authorize);
          store.audit(session.user.id, 'platform.backup', undefined, copy.id);
          return json(res, copy, 201);
        }
        if (await platformApi(req, res, url)) return;
        const match = url.pathname.match(/^\/api\/gyms\/([a-f\d-]{36})\/(.+)$/i);
        if (!match) throw new ApiError(404, 'Ruta no encontrada.');
        const gymId = match[1];
        const path = match[2].split('/').filter(Boolean);
        const operationalWrite =
          writing && path[0] !== 'auth' && !(method === 'POST' && path.length === 1 && path[0] === 'backups');
        const token = requestToken(req);
        if (
          path.length === 1 &&
          ((path[0] === 'device-access' && method === 'POST') || (path[0] === 'device-check' && method === 'GET'))
        ) {
          const gym = store.requireOperationalGym(gymId);
          const deviceToken = req.headers.authorization?.match(/^Bearer ([A-Za-z\d_-]+)$/)?.[1];
          if (!deviceToken) throw new ApiError(401, 'Falta la clave del lector.');
          const body = method === 'POST' ? await readJson(req) : undefined;
          return await tenants.withTenant(gym, async (ctx) => {
            store.requireOperationalGym(gymId);
            const device = await ctx.db
              .prepare('SELECT * FROM devices WHERE hash=? AND active=1')
              .bind(await hash(deviceToken))
              .first<Record<string, any>>();
            if (!device) throw new ApiError(401, 'Lector no autorizado.');
            store.requireOperationalGym(gymId);
            if (path[0] === 'device-check')
              return json(res, {
                ok: true,
                device: {
                  id: device.id,
                  name: device.name,
                  kind: device.kind,
                  direction: device.direction,
                  zone_id: device.zone_id,
                },
              });
            const reauthorizeDevice = () => {
              store.requireOperationalGym(gymId);
              if (
                !ctx.db.raw
                  .prepare('SELECT 1 FROM devices WHERE id=? AND hash=? AND active=1')
                  .get(device.id, device.hash)
              )
                throw new ApiError(401, 'Lector no autorizado.');
            };
            const service = new Service(
              authorizedDatabase(ctx.db, reauthorizeDevice),
              { id: device.id, email: 'device', name: device.name, role: 'operator' },
              ctx.codec,
            );
            const event = await service.access(body, device);
            return json(res, {
              allowed: !!event.allowed,
              reason: event.reason,
              message: reasons[event.reason],
              event_id: event.id,
              person_name: event.person_name,
            });
          });
        }
        const mobile = !!req.headers.authorization;
        const kioskRoute =
          (method === 'GET' && path.join('/') === 'kiosk/bootstrap') ||
          (method === 'POST' && path.join('/') === 'kiosk/start') ||
          (method === 'POST' && path.join('/') === 'access') ||
          (method === 'GET' && path.join('/') === 'branding/logo');
        if (mobile) {
          const allowed =
            (method === 'GET' &&
              path.length === 2 &&
              path[0] === 'mobile' &&
              ['bootstrap', 'people', 'presence', 'events', 'gym-sessions'].includes(path[1])) ||
            (method === 'GET' && path[0] === 'people' && path[2] === 'photo' && path.length === 3) ||
            (method === 'POST' && path.length === 1 && path[0] === 'access') ||
            (method === 'POST' && path.join('/') === 'auth/mobile-logout');
          if (!allowed) throw new ApiError(403, 'La sesión móvil solo permite controlar accesos.');
        }
        const imageGet =
          method === 'GET' &&
          ((path[0] === 'branding' && path[1] === 'logo') || (path[0] === 'people' && path[2] === 'photo'));
        const support = String(
          req.headers['x-gympass-support'] || (imageGet ? cookieValue(req, 'gympass_support') : '') || '',
        );
        const auth = await store.authorize(token, gymId, support, operationalWrite, kioskRoute);
        if (path[0] === 'auth' && ['logout', 'password'].includes(path[1])) {
          const alias = new URL(url);
          alias.pathname = '/api/platform/' + path[1];
          if (await platformApi(req, res, alias)) return;
        }
        if (path.join('/') === 'auth/mobile-logout' && method === 'POST') {
          await store.logout(token);
          return json(res, { ok: true });
        }
        return await tenants.withTenant(auth.gym, async (ctx) => {
          const current = await store.authorize(token, gymId, support, operationalWrite, kioskRoute);
          if (current.support && writing)
            store.audit(current.user.id, 'support.request', gymId, method + ' ' + path.join('/'));
          const reauthorize = () => {
            const latest = store.authorizeSync(token, gymId, support, operationalWrite, kioskRoute);
            if (latest.actor.role !== current.actor.role)
              throw new ApiError(403, 'Tus permisos cambiaron. Vuelve a abrir el gimnasio.');
          };
          await gymApi(req, res, url, path, ctx, current, store, tenants, reauthorize, token, support);
        });
      }
      if (method !== 'GET' && method !== 'HEAD') throw new ApiError(404, 'Ruta no encontrada.');
      const asset = await staticAsset(
        resolve(root, 'dist'),
        decodeURIComponent(url.pathname),
        String(req.headers['accept-encoding'] || ''),
      );
      if (!asset) throw new ApiError(404, 'Archivo no encontrado.');
      if (req.headers['if-none-match'] === asset.etag) {
        res.writeHead(304, asset.headers);
        res.end();
        return;
      }
      if (method === 'HEAD') {
        res.writeHead(200, asset.headers);
        res.end();
        return;
      }
      const content = await staticBytes(asset);
      res.writeHead(200, asset.headers);
      res.end(content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ApiError) return json(res, { error: error.message }, error.status);
      if (error instanceof ZodError)
        return json(
          res,
          { error: 'Revisa los campos: ' + error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') },
          400,
        );
      if (error instanceof URIError) return json(res, { error: 'Dirección inválida.' }, 400);
      if (error instanceof Error && /UNIQUE constraint/.test(error.message))
        return json(res, { error: 'Ya existe un registro con ese identificador.' }, 409);
      console.error('Plataforma:', error instanceof Error ? error.message : 'Error interno');
      return json(res, { error: 'No se pudo completar la operación.' }, 500);
    }
  });
  realtime = createRealtime(server, store, origin);
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 3000, host, done);
    });
  } catch (error) {
    realtime.close();
    await tenants.close();
    store.close();
    unlock();
    throw error;
  }
  const address = server.address();
  const url = `http://${host.includes(':') ? '[' + host + ']' : host}:${typeof address === 'object' && address ? address.port : options.port}`;
  const maintain = () => {
    if (maintenanceWork) return;
    maintenanceWork = tenants
      .maintain(
        store.listAllGyms().filter((g) => g.status !== 'provisioning' && !g.deleted),
        new Date(),
        (gym) => realtime?.publish(gym, ['access', 'alerts']),
      )
      .then(() => tenants.automaticPlatformBackup(store.raw))
      .catch((error) => console.error('Respaldo de plataforma:', error.message))
      .finally(() => {
        maintenanceWork = null;
      });
  };
  const timer = setInterval(maintain, 60000);
  timer.unref();
  maintain();
  return {
    server,
    store,
    tenants,
    url,
    async close() {
      clearInterval(timer);
      realtime?.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeIdleConnections();
      });
      await maintenanceWork;
      await tenants.close();
      store.close();
      unlock();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const allowHttp = process.env.GYMPASS_ALLOW_HTTP === '1';
  // Sin top-level await: LiteSpeed carga el arranque con require() y falla
  // con ERR_REQUIRE_ASYNC_MODULE si este modulo queda asincrono.
  void startPlatform({
    dataDirectory: resolve(process.env.GYMPASS_DATA_DIR || resolve(root, 'platform-data')),
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '127.0.0.1',
    publicOrigin: process.env.PUBLIC_ORIGIN,
    allowHttp,
    maxOpen: Number(process.env.GYMPASS_MAX_OPEN || 32),
  }).then((app) => {
    console.log('GymPASS plataforma:', process.env.PUBLIC_ORIGIN || app.url);
    for (const event of ['SIGINT', 'SIGTERM'] as const)
      process.once(event, () => {
        void app.close().then(() => process.exit(0));
      });
  });
}
