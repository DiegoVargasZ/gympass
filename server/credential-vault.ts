import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, type CredentialCodec } from '../lib/service.ts';

/** Only the local server holds this key. Lists and bootstrap never include recoverable QR codes. */
export function credentialVault(filename: string): CredentialCodec {
  mkdirSync(dirname(filename), { recursive: true });
  if (!existsSync(filename)) {
    try {
      writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const key = readFileSync(filename);
  if (key.length !== 32)
    throw Error('La clave de las tarjetas no es válida. Restaura credentials.key desde una copia de seguridad.');
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return {
    seal(code, id) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
      return [
        'v1',
        keyId,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.');
    },
    open(value, id) {
      try {
        const [version, storedKey, iv, tag, data] = value.split('.');
        if (version !== 'v1' || storedKey !== keyId) throw Error('Otra clave.');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new ApiError(
          409,
          'No se pudo recuperar esta tarjeta. Restaura credentials.key desde el respaldo o emite un QR nuevo.',
        );
      }
    },
  };
}
