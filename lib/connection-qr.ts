import qrcode from 'qrcode-generator';

qrcode.stringToBytes = (value) => Array.from(new TextEncoder().encode(value));

/** Connection links contain a pairing key and need more capacity than a credential QR. */
export function connectionQr(value: string) {
  if (new TextEncoder().encode(value).length > 1024) throw Error('La dirección de conexión es demasiado larga.');
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}
