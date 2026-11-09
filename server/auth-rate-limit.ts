import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ApiError } from '../lib/service.ts';

type Entry = { failures: number; pending: number; until: number };
const windowMs = 15 * 60_000;
const maximum = 30;

/** Only explicitly trusted peers may supply a forwarding chain. Never trust arbitrary headers. */
export function clientAddressResolver(configuration = '') {
  const trusted = new BlockList();
  const normalize = (value: string) => value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  for (const item of configuration.split(',').map((value) => value.trim()).filter(Boolean)) {
    const [raw, prefix, ...extra] = item.split('/');
    const address = normalize(raw);
    const family = isIP(address);
    if (!family || extra.length || prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
      throw Error('GYMPASS_TRUSTED_PROXIES debe contener direcciones IP o redes CIDR válidas.');
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) trusted.addAddress(address, type);
    else trusted.addSubnet(address, Number(prefix), type);
  }
  const isTrusted = (address: string) => {
    const family = isIP(address);
    return !!family && trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
  return (req: IncomingMessage) => {
    let address = normalize(req.socket.remoteAddress || 'unknown');
    const header = req.headers['x-forwarded-for'];
    if (!isTrusted(address) || typeof header !== 'string' || header.length > 2048) return address;
    const chain = header.split(',').map((value) => normalize(value.trim()));
    if (chain.length > 32 || chain.some((value) => !isIP(value))) return address;
    for (let index = chain.length - 1; index >= 0 && isTrusted(address); index--) address = chain[index];
    return address;
  };
}

/** Account limits are shared by web/mobile; one account cannot exhaust another's allowance. */
export function createLoginLimiter(configuration = '', now = Date.now) {
  const address = clientAddressResolver(configuration);
  const entries = new Map<string, Entry>();
  return async function limited<T>(req: IncomingMessage, res: ServerResponse, email: string, work: () => Promise<T>): Promise<T> {
    if (email.length > 254) throw new ApiError(400, 'Correo inválido.');
    const account = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const keys = ['account:' + account, 'client:' + address(req) + ':' + account];
    const at = now();
    for (const [key, value] of entries) if (value.until <= at && value.pending === 0) entries.delete(key);
    // Bound memory without evicting active throttles: fail closed for new identities when saturated.
    if (keys.some((key) => !entries.has(key)) && entries.size > 20_000) {
      res.setHeader('Retry-After', '60');
      throw new ApiError(429, 'Demasiados intentos. Espera unos minutos.');
    }
    const values = keys.map((key) => {
      let value = entries.get(key);
      if (!value) { value = { failures: 0, pending: 0, until: at + windowMs }; entries.set(key, value); }
      return value;
    });
    const blocked = values.find((value) => value.failures + value.pending >= maximum);
    if (blocked) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.until - at) / 1000))));
      throw new ApiError(429, 'Demasiados intentos. Espera unos minutos.');
    }
    for (const value of values) value.pending++;
    try {
      const result = await work();
      for (const value of values) value.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403))
        for (const value of values) value.failures++;
      throw error;
    } finally {
      values.forEach((value, index) => { value.pending--; if (!value.pending && !value.failures) entries.delete(keys[index]); });
    }
  };
}
