import { createHmac } from 'node:crypto';

export function activationCode(
  machineId: string,
  secret: string,
  monthly?: { months: number; issuedAt: number },
): string {
  if (!/^GP-[A-F0-9]{8}-[A-F0-9]{8}$/.test(machineId)) throw Error('ID de computadora inválido.');
  if (secret.length < 64) throw Error('Falta la configuración del emisor de licencias.');
  if (
    monthly &&
    (!Number.isInteger(monthly.months) ||
      monthly.months < 1 ||
      monthly.months > 99 ||
      !Number.isFinite(monthly.issuedAt))
  )
    throw Error('Indica una duración de 1 a 99 meses y una fecha válida.');
  const payload = monthly
    ? `GymPASS-2.1|${machineId}|${monthly.months}|${Math.floor(monthly.issuedAt / 86400000)}`
    : 'GymPASS-2|' + machineId;
  const digest = createHmac('sha256', secret).update(payload).digest();
  if (monthly) {
    const prefix = String(monthly.months).padStart(2, '0');
    let suffix = digest.readBigUInt64BE(0) % 1000000n;
    let code = prefix + suffix.toString().padStart(6, '0');
    if (code === activationCode(machineId, secret)) {
      suffix = (suffix + 1n) % 1000000n;
      code = prefix + suffix.toString().padStart(6, '0');
    }
    return code;
  }
  return (digest.readBigUInt64BE(0) % 100000000n).toString().padStart(8, '0');
}
