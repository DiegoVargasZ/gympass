import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../lib/service.ts';
import { sessionSeconds } from './auth.ts';
import { PlatformStore, type Gym, type GymScope } from './platform-store.ts';

export const platformCookieName = 'gympass_platform';
export function platformRequestToken(req: IncomingMessage) {
  return (
    req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(platformCookieName + '='))
      ?.slice(platformCookieName.length + 1) ?? ''
  );
}

function secure(req: IncomingMessage, force = false) {
  return (
    force ||
    process.env.NODE_ENV === 'production' ||
    process.env.SECURE_COOKIES === '1' ||
    Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    process.env.PUBLIC_ORIGIN?.startsWith('https://') === true
  );
}

function sessionCookie(req: IncomingMessage, value: string, remember = false, clear = false, force = false) {
  return `${platformCookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : sessionSeconds(remember)}${secure(req, force) ? '; Secure' : ''}`;
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new ApiError(413, 'La solicitud es demasiado grande.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, any>;
  } catch {
    throw new ApiError(400, 'JSON inválido.');
  }
}

function send(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

/** `?scope=archived|deleted` elige la vista del panel; cualquier otro valor lista los activos. */
function gymScope(params: URLSearchParams): GymScope {
  const scope = params.get('scope') ?? (params.get('archived') === '1' ? 'archived' : 'active');
  return scope === 'archived' || scope === 'deleted' ? scope : 'active';
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ApiError(400, `${label} es obligatorio.`);
  return value;
}

export function createPlatformApi(
  store: PlatformStore,
  options: { provisionGym: (gym: Gym) => Promise<void>; secureCookies?: boolean },
) {
  const cookie = (req: IncomingMessage, value: string, remember = false, clear = false) =>
    sessionCookie(req, value, remember, clear, options.secureCookies);
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!path.startsWith('/api/platform/')) return false;
    const method = req.method ?? 'GET',
      value = platformRequestToken(req);
    try {
      if (method === 'GET' && path === '/api/platform/status') {
        const current = await store.authenticate(value);
        if (current?.kioskGymId) {
          const gym = store.requireOperationalGym(current.kioskGymId);
          store.authorizeSync(value, gym.id, undefined, false, true);
          send(res, { mode: 'platform', protocol: 1, user: null, gyms: [], kiosk: { id: gym.id, name: gym.name } });
          return true;
        }
        const user = current && !current.mobileGymId ? current.user : null;
        send(res, {
          mode: 'platform',
          protocol: 1,
          user,
          gyms: user ? store.listGyms(user, gymScope(url.searchParams)) : [],
        });
        return true;
      }
      if (method === 'POST' && (path === '/api/platform/login' || path === '/api/platform/mobile-login')) {
        const input = await body(req);
        const credentials = {
          email: required(input.email, 'El correo'),
          password: required(input.password, 'La contraseña'),
          remember: input.remember === true,
        };
        if (path.endsWith('/mobile-login')) {
          if (input.gym_id !== undefined && typeof input.gym_id !== 'string')
            throw new ApiError(400, 'Gimnasio inválido.');
          send(res, await store.mobileLogin({ ...credentials, gymId: input.gym_id }));
        } else {
          const login = await store.login(credentials);
          res.setHeader('Set-Cookie', cookie(req, login.token, credentials.remember));
          send(res, { user: login.session.user, gyms: store.listGyms(login.session.user) });
        }
        return true;
      }
      if (method === 'POST' && path === '/api/platform/invitations/accept') {
        const input = await body(req);
        send(res, {
          user: await store.acceptInvitation(
            { token: required(input.token, 'El enlace'), name: input.name, password: input.password },
            value || undefined,
          ),
        });
        return true;
      }
      if (method === 'POST' && path === '/api/platform/recovery/accept') {
        const input = await body(req);
        await store.acceptRecovery(required(input.token, 'El enlace'), required(input.password, 'La contraseña'));
        res.setHeader('Set-Cookie', cookie(req, '', false, true));
        send(res, { ok: true });
        return true;
      }
      // Read the body before resolving permissions so an upload cannot retain an old grant.
      const input = ['POST', 'PATCH', 'PUT'].includes(method) ? await body(req) : {};
      if (method === 'POST' && path === '/api/platform/logout') {
        const current = store.authenticateSync(value);
        if (!current || current.mobileGymId) throw new ApiError(401, 'Inicia sesión en la plataforma.');
        await store.logout(value);
        res.setHeader('Set-Cookie', cookie(req, '', false, true));
        send(res, { ok: true });
        return true;
      }
      const session = await store.requireWebSession(value);
      const actor = session.user;
      if (method === 'POST' && path === '/api/platform/password') {
        await store.changePassword(
          value,
          required(input.current, 'La contraseña actual'),
          required(input.password, 'La contraseña'),
        );
        res.setHeader('Set-Cookie', cookie(req, '', false, true));
        send(res, { ok: true });
      } else if (method === 'GET' && path === '/api/platform/gyms') {
        send(res, { gyms: store.listGyms(actor, gymScope(url.searchParams)) });
      } else if (method === 'GET' && path === '/api/platform/billing') {
        send(res, store.billing.summary(actor, url.searchParams.get('month') ?? ''));
      } else if (method === 'POST' && path === '/api/platform/gyms') {
        const admin = {
          name: required(input.admin_name, 'El nombre del administrador'),
          email: required(input.admin_email, 'El correo del administrador'),
          role: 'admin' as const,
        };
        if (
          !admin.name.trim() ||
          admin.name.trim().length > 120 ||
          admin.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin.email.trim())
        )
          throw new ApiError(400, 'Revisa el nombre y correo del administrador.');
        const direct = Object.prototype.hasOwnProperty.call(input, 'admin_password');
        const password = direct ? required(input.admin_password, 'La contraseña del administrador') : undefined;
        if (password !== undefined && (password.length < 6 || password.length > 200))
          throw new ApiError(400, 'La contraseña debe tener entre 6 y 200 caracteres.');
        const gym = store.createGym(actor, {
          name: required(input.name, 'El nombre'),
          slug: required(input.slug, 'El identificador'),
        });
        await options.provisionGym(gym);
        const freshSession = await store.requireWebSession(value);
        store.markGymProvisioned(gym.id);
        if (direct) {
          const member = await store.createMember(freshSession.user, gym.id, { ...admin, password: password! }, value);
          send(res, { gym: store.getGym(gym.id), member }, 201);
        } else {
          const invitation = store.invite(freshSession.user, gym.id, admin);
          send(res, { gym: store.getGym(gym.id), invitation }, 201);
        }
      } else if (method === 'GET' && path === '/api/platform/audit') {
        send(res, { audit: store.listAudit(actor) });
      } else {
        const billingRoute = /^\/api\/platform\/gyms\/([^/]+)\/billing(?:\/(payments)(?:\/([^/]+)\/(void))?)?$/.exec(
          path,
        );
        if (billingRoute) {
          const [, gymId, resource, paymentId] = billingRoute;
          if (method === 'GET' && !resource) send(res, store.billing.account(actor, gymId));
          else if (method === 'PATCH' && !resource)
            send(
              res,
              store.billing.configure(actor, gymId, {
                monthly_fee_cents: input.monthly_fee_cents,
                start_month: input.start_month,
                due_day: input.due_day,
              }),
            );
          else if (method === 'POST' && resource === 'payments' && !paymentId)
            send(
              res,
              {
                payment: store.billing.pay(actor, gymId, {
                  request_id: input.request_id,
                  charge_id: input.charge_id,
                  amount_cents: input.amount_cents,
                  paid_on: input.paid_on,
                  method: input.method,
                  reference: input.reference,
                }),
              },
              201,
            );
          else if (method === 'POST' && paymentId)
            send(res, { payment: store.billing.voidPayment(actor, gymId, paymentId, input.reason) });
          else throw new ApiError(404, 'Ruta de cobros no encontrada.');
          return true;
        }
        const gymRoute =
          /^\/api\/platform\/gyms\/([^/]+)(?:\/(members|invitations|support|restore)(?:\/([^/]+))?)?$/.exec(path);
        const memberPasswordRoute = /^\/api\/platform\/gyms\/([^/]+)\/members\/([^/]+)\/password$/.exec(path);
        const supportRoute = /^\/api\/platform\/support\/([a-f0-9]{64})$/.exec(path);
        const recoveryRoute = /^\/api\/platform\/users\/([^/]+)\/recovery$/.exec(path);
        if (method === 'POST' && memberPasswordRoute) {
          await store.setMemberPassword(
            actor,
            memberPasswordRoute[1],
            memberPasswordRoute[2],
            required(input.password, 'La contraseña'),
            value,
          );
          send(res, { ok: true });
        } else if (gymRoute) {
          const [, gymId, resource, memberId] = gymRoute;
          if (method === 'DELETE' && !resource) send(res, { gym: store.deleteGym(actor, gymId) });
          else if (method === 'POST' && resource === 'restore' && !memberId)
            send(res, { gym: store.restoreGym(actor, gymId) });
          else if (method === 'PATCH' && !resource)
            send(res, {
              gym: store.updateGym(actor, gymId, {
                name: input.name,
                status: input.status,
                archived: input.archived,
                contact_name: input.contact_name,
                contact_email: input.contact_email,
                contact_phone: input.contact_phone,
              }),
            });
          else if (method === 'GET' && resource === 'members' && !memberId)
            send(res, { members: store.listMembers(actor, gymId) });
          else if (method === 'POST' && resource === 'members' && !memberId)
            send(
              res,
              {
                member: await store.createMember(
                  actor,
                  gymId,
                  {
                    name: required(input.name, 'El nombre'),
                    email: required(input.email, 'El correo'),
                    role: input.role,
                    password: required(input.password, 'La contraseña'),
                  },
                  value,
                ),
              },
              201,
            );
          else if (method === 'POST' && resource === 'invitations' && !memberId)
            send(
              res,
              {
                invitation: store.invite(actor, gymId, {
                  name: required(input.name, 'El nombre'),
                  email: required(input.email, 'El correo'),
                  role: input.role,
                }),
              },
              201,
            );
          else if (method === 'PATCH' && resource === 'members' && memberId)
            send(res, {
              member: store.updateMembership(actor, gymId, memberId, { role: input.role, active: input.active }),
            });
          else if (method === 'POST' && resource === 'support' && !memberId) {
            const grant = await store.createSupport(value, gymId, required(input.reason, 'El motivo'));
            res.setHeader(
              'Set-Cookie',
              `gympass_support=${grant.support_token}; HttpOnly; SameSite=Strict; Path=/api/gyms/${gymId}/; Max-Age=1800${secure(req, options.secureCookies) ? '; Secure' : ''}`,
            );
            send(res, grant, 201);
          } else throw new ApiError(404, 'Ruta de plataforma no encontrada.');
        } else if (method === 'DELETE' && supportRoute) {
          await store.revokeSupport(value, supportRoute[1]);
          send(res, { ok: true });
        } else if (method === 'POST' && recoveryRoute) {
          const recovery = store.createRecovery(actor, recoveryRoute[1]);
          send(res, { ...recovery, link: `/#recovery=${recovery.token}` }, 201);
        } else throw new ApiError(404, 'Ruta de plataforma no encontrada.');
      }
    } catch (error) {
      if (error instanceof ApiError) send(res, { error: error.message }, error.status);
      else send(res, { error: 'No se pudo completar la operación.' }, 500);
    }
    return true;
  };
}
